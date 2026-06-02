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

const COMMAND_NAME = "vr.addLineaComanda";

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

async function buildVrWriteContext(
    req: Request,
    env: any,
    dbCentral: Client,
): Promise<{ tenantId: string; deviceId: string }> {
    const ctx = await buildTenantContext(req, env, dbCentral, createDbClient);

    const tenantId = String(ctx?.claims?.tenantId ?? "").trim();
    const deviceId = String(ctx?.claims?.deviceId ?? "").trim();

    if (!tenantId || !deviceId) {
        throw new Error("invalid_token_claims");
    }

    const role = await getDeviceRole(dbCentral, tenantId, deviceId);
    if (!role) throw new Error("device_not_registered");

    /*
      De momento mantenemos el comportamiento actual:
      esta ruta solo permite TPV. Handy es online-only, pero no
      lo abrimos aquí para no cambiar permisos funcionales ahora.
    */
    if (role !== "tpv") throw new Error("forbidden_not_tpv");

    return { tenantId, deviceId };
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

function updateTotalComandaSql(): string {
    return `
        UPDATE Comandas
        SET Total_Comanda = (
          SELECT IFNULL(SUM(COALESCE(Cantidad,1) * COALESCE(Precio_Unitario,0)), 0)
          FROM Detalle_Comanda
          WHERE ID_Comanda = ?1
        )
        WHERE ID_Comanda = ?1;
    `;
}

export async function handleVrAddLineaComanda(
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

        const idComanda = asNumber(args.idComanda ?? args.id_comanda ?? 0, 0);
        const idProducto = asNumber(args.idProducto ?? args.id_producto ?? 0, 0);
        const cantidad = asNumber(args.cantidad ?? 0, 0);
        const precioUnitario = asNumber(
            args.precioUnitario ?? args.precio_unitario ?? 0,
            0,
        );

        const forcedIdDetalle = asNumber(
            args.idDetalle ?? args.id_detalle ?? 0,
            0,
        );

        if (
            idComanda <= 0 ||
            idProducto <= 0 ||
            cantidad <= 0 ||
            !Number.isFinite(precioUnitario)
        ) {
            return json({ ok: true, result: 0, id_detalle: 0 }, 200, req);
        }

        const domainArgs: Record<string, any> = {
            id_comanda: idComanda,
            id_producto: idProducto,
            cantidad,
            precio_unitario: precioUnitario,
        };

        if (forcedIdDetalle > 0) {
            domainArgs.id_detalle = forcedIdDetalle;
        }

        const cloudPayload = {
            op_id: opId,
            command_name: COMMAND_NAME,
            args: domainArgs,
        };

        const steps: TxStep[] = [];

        steps.push({
            kind: "value",
            saveAs: "producto_exists",
            sql: `
                SELECT CASE
                    WHEN EXISTS (
                        SELECT 1
                        FROM Productos
                        WHERE ID_Producto = ?1
                        LIMIT 1
                    )
                    THEN 1
                    ELSE 0
                END;
            `,
            args: [idProducto],
        });

        if (forcedIdDetalle > 0) {
            steps.push(
                {
                    kind: "execute",
                    sql: `
                        INSERT INTO Detalle_Comanda (
                            ID_Detalle,
                            ID_Comanda,
                            ID_Producto,
                            Cantidad,
                            Precio_Unitario,
                            Notas,
                            Estado_Cocina
                        )
                        SELECT
                            ?1,
                            ?2,
                            p.ID_Producto,
                            ?4,
                            ?5,
                            NULL,
                            CASE
                                WHEN COALESCE(c.Pasa_Cocina, 0) = 1 THEN 'PENDIENTE'
                                ELSE NULL
                            END
                        FROM Productos p
                        LEFT JOIN Categorias_Producto c
                          ON c.ID_Categoria = p.ID_Categoria
                        WHERE p.ID_Producto = ?3
                          AND COALESCE(?6, 0) = 1
                        LIMIT 1
                        ON CONFLICT(ID_Detalle) DO UPDATE SET
                            ID_Comanda = excluded.ID_Comanda,
                            ID_Producto = excluded.ID_Producto,
                            Cantidad = excluded.Cantidad,
                            Precio_Unitario = excluded.Precio_Unitario,
                            Estado_Cocina = COALESCE(
                                Detalle_Comanda.Estado_Cocina,
                                excluded.Estado_Cocina
                            );
                    `,
                    args: [
                        forcedIdDetalle,
                        idComanda,
                        idProducto,
                        cantidad,
                        precioUnitario,
                        sqlRef("producto_exists"),
                    ],
                },
                {
                    kind: "value",
                    saveAs: "id_detalle",
                    sql: `
                        SELECT CASE
                            WHEN COALESCE(?1, 0) = 1 THEN ?2
                            ELSE 0
                        END;
                    `,
                    args: [sqlRef("producto_exists"), forcedIdDetalle],
                },
            );
        } else {
            steps.push(
                {
                    kind: "execute",
                    sql: `
                        INSERT INTO Detalle_Comanda (
                            ID_Comanda,
                            ID_Producto,
                            Cantidad,
                            Precio_Unitario,
                            Notas,
                            Estado_Cocina
                        )
                        SELECT
                            ?1,
                            p.ID_Producto,
                            ?3,
                            ?4,
                            NULL,
                            CASE
                                WHEN COALESCE(c.Pasa_Cocina, 0) = 1 THEN 'PENDIENTE'
                                ELSE NULL
                            END
                        FROM Productos p
                        LEFT JOIN Categorias_Producto c
                          ON c.ID_Categoria = p.ID_Categoria
                        WHERE p.ID_Producto = ?2
                          AND COALESCE(?5, 0) = 1
                        LIMIT 1;
                    `,
                    args: [
                        idComanda,
                        idProducto,
                        cantidad,
                        precioUnitario,
                        sqlRef("producto_exists"),
                    ],
                },
                {
                    kind: "value",
                    saveAs: "inserted_rows",
                    sql: `SELECT changes();`,
                    args: [],
                },
                {
                    kind: "value",
                    saveAs: "id_detalle",
                    sql: `
                        SELECT CASE
                            WHEN COALESCE(?1, 0) > 0 THEN last_insert_rowid()
                            ELSE 0
                        END;
                    `,
                    args: [sqlRef("inserted_rows")],
                },
            );
        }

        steps.push({
            kind: "execute",
            sql: updateTotalComandaSql(),
            args: [idComanda],
        });

        const idDetalle = await applyTenantHubTransaction<number>({
            env,
            tenantId: ctx.tenantId,
            opId,
            commandName: COMMAND_NAME,
            deviceId: ctx.deviceId,
            beginMode: "immediate",
            steps,
            resultKey: "id_detalle",

            /*
              Importante para sync:
              Cloud_Changes.Payload_Json debe guardar este envelope de dominio,
              no el payload SQL interno de TenantHub.
            */
            cloudPayload,

            /*
              Importante para idempotencia:
              el hash se calcula contra los argumentos de dominio.
            */
            requestPayload: cloudPayload,
        });

        const finalId = asNumber(idDetalle, 0);

        return json(
            {
                ok: true,
                result: finalId,
                id_detalle: finalId,
                idDetalle: finalId,
            },
            200,
            req,
        );
    } catch (e: any) {
        return handleVrWriteError(req, e);
    }
}