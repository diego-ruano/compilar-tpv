import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../../middleware/withTenant";
import { createDbClient } from "../../../../../db/clients";
import { json, unauthorized, serverError } from "../../../../../utils/response";
import {
    applyTenantHubTransaction,
    readWriteRequest,
    sqlRef,
    type TxStep,
} from "../../../../../utils/tenantHubWrites";

const COMMAND_NAME = "vr.restarStock";

function asNumber(v: any, fallback = 0): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

async function getDeviceRole(
    dbCentral: Client,
    tenantId: string,
    deviceId: string,
): Promise<"tpv" | "handy" | "unknown" | null> {
    const r = await dbCentral.execute({
        sql: `
            SELECT role, revoked_at_ms
            FROM devices
            WHERE tenant_id=? AND device_id=?
            LIMIT 1
        `,
        args: [tenantId, deviceId],
    });

    const row = r.rows?.[0] as any | undefined;
    if (!row) return null;
    if (row.revoked_at_ms) return null;

    const role = String(row.role || "").trim().toLowerCase();
    if (role === "tpv") return "tpv";
    if (role === "handy") return "handy";
    return "unknown";
}

function pickTenantDb(ctx: any): Client {
    const db =
        (ctx?.dbTenant as Client) ||
        (ctx?.db as Client) ||
        (ctx?.tenantDb as Client) ||
        (ctx?.client as Client);

    if (!db) throw new Error("tenant_db_missing");
    return db;
}

async function buildVrWriteContext(
    req: Request,
    env: any,
    dbCentral: Client,
): Promise<{ tenantId: string; deviceId: string; tenantDb: Client }> {
    const ctx = await buildTenantContext(req, env, dbCentral, createDbClient);

    const tenantId = String(ctx?.claims?.tenantId ?? "").trim();
    const deviceId = String(ctx?.claims?.deviceId ?? "").trim();

    if (!tenantId || !deviceId) {
        throw new Error("invalid_token_claims");
    }

    const role = await getDeviceRole(dbCentral, tenantId, deviceId);
    if (!role) throw new Error("device_not_registered");

    if (role !== "tpv") throw new Error("forbidden_not_tpv");

    return { tenantId, deviceId, tenantDb: pickTenantDb(ctx) };
}

function isAuthError(msg: string): boolean {
    return (
        msg.includes("missing_token") ||
        msg.includes("invalid_token") ||
        msg.includes("invalid_token_claims") ||
        msg.includes("missing_device_proof") ||
        msg.includes("bad_device_signature") ||
        msg.includes("device_ts_out_of_range") ||
        msg.includes("device_pubkey_not_registered") ||
        msg.includes("bad_device_ts") ||
        msg.includes("bad_b64") ||
        msg.includes("device_not_registered") ||
        msg.includes("device_revoked") ||
        msg.includes("forbidden")
    );
}

function handleVrWriteError(req: Request, e: any): Response {
    const msg = String(e?.message || e);

    if (isAuthError(msg)) {
        return unauthorized(req, msg);
    }

    return serverError(req, "internal_error", {
        message: msg,
        name: e?.name,
        stack: e?.stack,
    });
}

function normalizeLineas(rawLineas: any[]): Array<{ producto_id: number; cantidad: number }> {
    const byProduct = new Map<number, number>();

    for (const it of rawLineas) {
        const productoId = asNumber(
            it?.productoId ?? it?.producto_id ?? it?.ID_Producto ?? 0,
            0,
        );

        const cantidad = asNumber(it?.cantidad ?? it?.Cantidad ?? 0, 0);

        if (productoId <= 0 || cantidad <= 0) continue;

        byProduct.set(productoId, (byProduct.get(productoId) ?? 0) + cantidad);
    }

    return Array.from(byProduct.entries())
        .map(([producto_id, cantidad]) => ({
            producto_id,
            cantidad,
        }))
        .sort((a, b) => a.producto_id - b.producto_id);
}

/*
  Decremento FEFO de un producto, gateado por stock_ok (?3).

  Solo descuenta si stock_ok = 1 (suficiencia validada de forma atómica para
  TODAS las líneas). Como la suficiencia está garantizada, el reparto nunca
  deja stock negativo. No escribe Lote_Consumos: este endpoint no recibe
  ID_Detalle, así que no inventa trazabilidad (la trazabilidad de venta rápida
  vive en vrCobrarFraccionado.ts).

  Placeholders: ?1 = id_producto, ?2 = cantidad, ?3 = $ref stock_ok.
*/
function buildRestarStockSql(): string {
    return `
        WITH ordered AS (
            SELECT
                ID_Lote,
                COALESCE(Stock_Disponible, 0) AS stock_actual,
                COALESCE(
                    SUM(COALESCE(Stock_Disponible, 0)) OVER (
                        ORDER BY
                            CASE WHEN Caducidad IS NULL THEN 1 ELSE 0 END,
                            date(Caducidad) ASC,
                            datetime(Fecha_Entrada) ASC,
                            ID_Lote ASC
                        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                    ),
                    0
                ) AS stock_previo,
                SUM(COALESCE(Stock_Disponible, 0)) OVER (
                    ORDER BY
                        CASE WHEN Caducidad IS NULL THEN 1 ELSE 0 END,
                        date(Caducidad) ASC,
                        datetime(Fecha_Entrada) ASC,
                        ID_Lote ASC
                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                ) AS stock_acumulado
            FROM Lotes_Producto
            WHERE ID_Producto = ?1
              AND COALESCE(Stock_Disponible, 0) > 0
        ),
        to_update AS (
            SELECT
                ID_Lote,
                CASE
                    WHEN ?2 <= stock_previo THEN stock_actual
                    WHEN ?2 >= stock_acumulado THEN 0
                    ELSE stock_actual - (?2 - stock_previo)
                END AS nuevo_stock
            FROM ordered
            WHERE ?2 > stock_previo
              AND COALESCE(?3, 0) = 1
        )
        UPDATE Lotes_Producto
        SET Stock_Disponible = (
            SELECT nuevo_stock
            FROM to_update
            WHERE to_update.ID_Lote = Lotes_Producto.ID_Lote
        )
        WHERE ID_Lote IN (
            SELECT ID_Lote
            FROM to_update
        );
    `;
}

type InsufficientStock = {
    productoId: number;
    requested: number;
    available: number;
};

/*
  Pre-check de suficiencia (read, fuera de la transacción).

  Un producto controla stock si tiene alguna fila en Lotes_Producto. Para esos,
  compara la cantidad solicitada con el stock disponible total. Los productos
  sin lotes (no inventariados) se ignoran (no validan ni descuentan), igual que
  el comportamiento histórico. Devuelve la primera línea sin stock suficiente.
*/
async function findInsufficientStock(
    db: Client,
    lineas: Array<{ producto_id: number; cantidad: number }>,
): Promise<InsufficientStock | null> {
    for (const it of lineas) {
        const r = await db.execute({
            sql: `
                SELECT
                    EXISTS(
                        SELECT 1 FROM Lotes_Producto WHERE ID_Producto = ?1
                    ) AS tracked,
                    COALESCE((
                        SELECT SUM(CAST(COALESCE(Stock_Disponible, 0) AS REAL))
                        FROM Lotes_Producto
                        WHERE ID_Producto = ?1
                    ), 0) AS available;
            `,
            args: [it.producto_id],
        });

        const row = r.rows?.[0] as any | undefined;
        const tracked = asNumber(row?.tracked ?? row?.TRACKED, 0) > 0;
        const available = asNumber(row?.available ?? row?.AVAILABLE, 0);

        if (tracked && it.cantidad > available) {
            return {
                productoId: it.producto_id,
                requested: it.cantidad,
                available,
            };
        }
    }

    return null;
}

export async function handleVrRestarStock(
    req: Request,
    env: any,
    dbCentral: Client,
): Promise<Response> {
    try {
        const ctx = await buildVrWriteContext(req, env, dbCentral);
        const { input: args, opId } = await readWriteRequest<any>(req, {});

        if (!opId) {
            return json({ ok: false, error: "missing_op_id" }, 400, req);
        }

        const rawLineas = Array.isArray(args.lineas) ? args.lineas : [];
        const lineas = normalizeLineas(rawLineas);

        if (lineas.length === 0) {
            return json({ ok: true, result: true }, 200, req);
        }

        /*
          VR-01/VR-05: ya no se descuenta de forma silenciosa con clamp a 0.
          Validamos suficiencia antes de tocar nada y devolvemos insufficient_stock
          si alguna línea no cabe entera. La transacción lo revalida (stock_ok)
          para cubrir la carrera entre el pre-check y el descuento.
        */
        const insufficient = await findInsufficientStock(ctx.tenantDb, lineas);

        if (insufficient) {
            return json(
                {
                    ok: false,
                    error: "insufficient_stock",
                    productoId: insufficient.productoId,
                    requested: insufficient.requested,
                    available: insufficient.available,
                    result: false,
                },
                409,
                req,
            );
        }

        const domainArgs = {
            lineas,
        };

        const cloudPayload = {
            op_id: opId,
            command_name: COMMAND_NAME,
            args: domainArgs,
        };

        const stockOkValues = lineas
            .map((_, i) => `(?${i * 2 + 1}, ?${i * 2 + 2})`)
            .join(", ");
        const stockOkArgs = lineas.flatMap((it) => [it.producto_id, it.cantidad]);

        const steps: TxStep[] = [];

        steps.push({
            /*
              stock_ok atómico: 0 si alguna línea (de producto inventariado) pide
              más de lo disponible; 1 en caso contrario. Cada decremento se gatea
              con stock_ok, así un fallo de stock no deja descuentos parciales.
            */
            kind: "value",
            saveAs: "stock_ok",
            sql: `
                SELECT CASE WHEN EXISTS (
                    WITH req(pid, requested) AS (VALUES ${stockOkValues})
                    SELECT 1
                    FROM req
                    WHERE EXISTS (
                        SELECT 1 FROM Lotes_Producto lp WHERE lp.ID_Producto = req.pid
                      )
                      AND req.requested > COALESCE((
                        SELECT SUM(CAST(COALESCE(lp.Stock_Disponible, 0) AS REAL))
                        FROM Lotes_Producto lp
                        WHERE lp.ID_Producto = req.pid
                      ), 0)
                ) THEN 0 ELSE 1 END;
            `,
            args: stockOkArgs,
        });

        for (const it of lineas) {
            steps.push({
                kind: "execute",
                sql: buildRestarStockSql(),
                args: [it.producto_id, it.cantidad, sqlRef("stock_ok")],
            });
        }

        steps.push({
            kind: "value",
            saveAs: "ok_value",
            sql: `SELECT COALESCE(?1, 0);`,
            args: [sqlRef("stock_ok")],
        });

        const okValue = await applyTenantHubTransaction<number>({
            env,
            tenantId: ctx.tenantId,
            opId,
            commandName: COMMAND_NAME,
            deviceId: ctx.deviceId,
            beginMode: "immediate",
            steps,
            resultKey: "ok_value",
            cloudPayload,
            requestPayload: cloudPayload,
        });

        if (asNumber(okValue, 0) !== 1) {
            /*
              Carrera: el stock dejó de ser suficiente entre el pre-check y la
              transacción. Los decrementos quedaron gateados (nada descontado).
            */
            return json(
                {
                    ok: false,
                    error: "insufficient_stock",
                    result: false,
                },
                409,
                req,
            );
        }

        return json(
            {
                ok: true,
                result: true,
            },
            200,
            req,
        );
    } catch (e: any) {
        return handleVrWriteError(req, e);
    }
}