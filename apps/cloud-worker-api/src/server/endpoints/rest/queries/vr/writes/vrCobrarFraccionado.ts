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

const COMMAND_NAME = "vr.cobrarFraccionado";

function asNumber(v: any, fallback = 0): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function uniquePositiveInts(values: any[]): number[] {
    const out = values
        .map((v) => Number(v))
        .filter((n) => Number.isFinite(n) && n > 0)
        .map((n) => Math.trunc(n));

    out.sort((a, b) => a - b);

    return out.filter((n, i) => (i === 0 ? true : n !== out[i - 1]));
}

function buildInPlaceholders(start: number, count: number): string {
    return Array.from({ length: count }, (_, i) => `?${start + i}`).join(", ");
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

async function countValidUnpaidDetalles(
    db: Client,
    idComanda: number,
    detalles: number[],
): Promise<number> {
    if (idComanda <= 0 || detalles.length === 0) return 0;

    const placeholders = detalles.map(() => "?").join(", ");
    const r = await db.execute({
        sql: `
            SELECT COUNT(*) AS valid_count
            FROM Detalle_Comanda dc
            WHERE dc.ID_Comanda = ?
              AND dc.ID_Detalle IN (${placeholders})
              AND NOT EXISTS (
                SELECT 1
                FROM Pago_Detalles pd
                WHERE pd.ID_Detalle = dc.ID_Detalle
              );
        `,
        args: [idComanda, ...detalles],
    });

    const row = r.rows?.[0] as any | undefined;
    return asNumber(row?.valid_count ?? row?.VALID_COUNT ?? Object.values(row ?? {})[0], 0);
}

type InsufficientStock = {
    productoId: number;
    requested: number;
    available: number;
};

/*
  Pre-check de stock fuera de la transacción.

  "Debe descontar stock" se determina por la lógica/esquema actual:
  un producto controla stock si existe alguna fila en Lotes_Producto para él.
  Los productos sin lotes (no inventariados) no validan ni descuentan.

  Para cada producto inventariado entre los detalles a cobrar, agrega la
  cantidad solicitada (solo líneas todavía no pagadas) y la compara con el
  stock disponible total. Devuelve el primer producto con stock insuficiente
  o null si todo es suficiente. La transacción vuelve a comprobarlo de forma
  atómica (stock_ok) para cubrir la carrera entre el pre-check y el cobro.
*/
async function findInsufficientStock(
    db: Client,
    idComanda: number,
    detalles: number[],
): Promise<InsufficientStock | null> {
    if (idComanda <= 0 || detalles.length === 0) return null;

    const placeholders = detalles.map(() => "?").join(", ");
    const r = await db.execute({
        sql: `
            SELECT
                req.pid AS producto_id,
                req.requested AS requested,
                COALESCE((
                    SELECT SUM(CAST(COALESCE(lp.Stock_Disponible, 0) AS REAL))
                    FROM Lotes_Producto lp
                    WHERE lp.ID_Producto = req.pid
                ), 0) AS available
            FROM (
                SELECT
                    dc.ID_Producto AS pid,
                    SUM(CAST(COALESCE(dc.Cantidad, 1) AS REAL)) AS requested
                FROM Detalle_Comanda dc
                WHERE dc.ID_Comanda = ?
                  AND dc.ID_Detalle IN (${placeholders})
                  AND NOT EXISTS (
                    SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = dc.ID_Detalle
                  )
                  AND EXISTS (
                    SELECT 1 FROM Lotes_Producto lp WHERE lp.ID_Producto = dc.ID_Producto
                  )
                GROUP BY dc.ID_Producto
            ) req
            WHERE req.requested > COALESCE((
                SELECT SUM(CAST(COALESCE(lp.Stock_Disponible, 0) AS REAL))
                FROM Lotes_Producto lp
                WHERE lp.ID_Producto = req.pid
            ), 0)
            ORDER BY req.pid
            LIMIT 1;
        `,
        args: [idComanda, ...detalles],
    });

    const row = r.rows?.[0] as any | undefined;
    if (!row) return null;

    return {
        productoId: asNumber(row.producto_id ?? row.PRODUCTO_ID, 0),
        requested: asNumber(row.requested ?? row.REQUESTED, 0),
        available: asNumber(row.available ?? row.AVAILABLE, 0),
    };
}

/*
  CTE de consumo FEFO reutilizable.

  IMPORTANTE (caveat libSQL): una CTE no sobrevive entre statements, así que
  este bloque WITH se antepone íntegro a cada statement que lo necesite
  (inserción en Lote_Consumos y decremento de Lotes_Producto).

  Placeholders:
    ?1                      -> id_comanda
    ?2 .. ?(1+n)            -> ids de detalle
    ?(2+n) (idPagoPh)       -> $ref id_pago (gate: solo consume si el pago se creó)

  El reparto asigna cada unidad de cada detalle a los lotes en orden FEFO
  (caducidad, fecha de entrada, id de lote) mediante el solapamiento de los
  rangos acumulados de demanda y de stock. No filtra por Pago_Detalles porque
  este CTE se ejecuta DESPUÉS de insertar los pagos: el gate por id_pago ya
  garantiza que solo se consume cuando el cobro completo fue válido.
*/
function buildStockConsumptionCte(detalleCount: number): {
    cte: string;
    idPagoPh: string;
} {
    const detIn = buildInPlaceholders(2, detalleCount);
    const idPagoPh = `?${detalleCount + 2}`;

    const fefoOrder = `
        CASE WHEN lp.Caducidad IS NULL THEN 1 ELSE 0 END,
        date(lp.Caducidad) ASC,
        datetime(lp.Fecha_Entrada) ASC,
        lp.ID_Lote ASC`;

    const cte = `
        WITH demand AS (
            SELECT
                dc.ID_Detalle AS id_detalle,
                dc.ID_Producto AS id_producto,
                SUM(CAST(COALESCE(dc.Cantidad, 1) AS REAL)) OVER (
                    PARTITION BY dc.ID_Producto
                    ORDER BY dc.ID_Detalle
                    ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                ) AS dem_prev,
                SUM(CAST(COALESCE(dc.Cantidad, 1) AS REAL)) OVER (
                    PARTITION BY dc.ID_Producto
                    ORDER BY dc.ID_Detalle
                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                ) AS dem_cum
            FROM Detalle_Comanda dc
            WHERE dc.ID_Comanda = ?1
              AND dc.ID_Detalle IN (${detIn})
              AND COALESCE(${idPagoPh}, 0) > 0
              AND EXISTS (
                SELECT 1 FROM Lotes_Producto lp WHERE lp.ID_Producto = dc.ID_Producto
              )
        ),
        lots AS (
            SELECT
                lp.ID_Lote AS id_lote,
                lp.ID_Producto AS id_producto,
                SUM(CAST(COALESCE(lp.Stock_Disponible, 0) AS REAL)) OVER (
                    PARTITION BY lp.ID_Producto
                    ORDER BY ${fefoOrder}
                    ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                ) AS lot_prev,
                SUM(CAST(COALESCE(lp.Stock_Disponible, 0) AS REAL)) OVER (
                    PARTITION BY lp.ID_Producto
                    ORDER BY ${fefoOrder}
                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                ) AS lot_cum
            FROM Lotes_Producto lp
            WHERE lp.ID_Producto IN (SELECT DISTINCT id_producto FROM demand)
              AND COALESCE(lp.Stock_Disponible, 0) > 0
        ),
        alloc AS (
            SELECT
                d.id_detalle AS id_detalle,
                l.id_lote AS id_lote,
                (
                    MIN(d.dem_cum, l.lot_cum)
                    - MAX(COALESCE(d.dem_prev, 0), COALESCE(l.lot_prev, 0))
                ) AS consumed
            FROM demand d
            JOIN lots l ON l.id_producto = d.id_producto
            WHERE (
                MIN(d.dem_cum, l.lot_cum)
                - MAX(COALESCE(d.dem_prev, 0), COALESCE(l.lot_prev, 0))
            ) > 0
        )`;

    return { cte, idPagoPh };
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

    /*
      Mantenemos comportamiento actual:
      venta rápida de esta ruta solo desde TPV.
      Handy sigue online-only, pero no abrimos permisos aquí en este bloque.
    */
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

export async function handleVrCobrarFraccionado(
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
        const forcedIdPago = asNumber(args.idPago ?? args.id_pago ?? 0, 0);

        const metodoRaw = String(args.metodo ?? "");
        const metodo = metodoRaw === "Tarjeta" ? "Tarjeta" : "Efectivo";

        const importeTotalInput = asNumber(
            args.importeTotal ?? args.importe_total ?? 0,
            0,
        );

        const idUsuarioCobradorRaw =
            args.idUsuarioCobrador ?? args.id_usuario_cobrador ?? null;

        const idTrabajadorCobradorRaw =
            args.idTrabajadorCobrador ?? args.id_trabajador_cobrador ?? null;

        const idUsuarioCobrador =
            asNumber(idUsuarioCobradorRaw, 0) > 0
                ? asNumber(idUsuarioCobradorRaw, 0)
                : null;

        const idTrabajadorExplicit =
            asNumber(idTrabajadorCobradorRaw, 0) > 0
                ? asNumber(idTrabajadorCobradorRaw, 0)
                : null;

        const detalles = uniquePositiveInts(
            Array.isArray(args.detalles)
                ? args.detalles
                : Array.isArray(args.detalle_ids)
                    ? args.detalle_ids
                    : Array.isArray(args.detalleIds)
                        ? args.detalleIds
                        : [],
        );

        if (idComanda <= 0 || detalles.length === 0) {
            return json(
                {
                    ok: false,
                    error: "detalles_required",
                    result: 0,
                    id_pago: 0,
                    idPago: 0,
                },
                400,
                req,
            );
        }

        const expectedDetalleCount = detalles.length;
        const validCountBeforeTx = await countValidUnpaidDetalles(ctx.tenantDb, idComanda, detalles);

        if (validCountBeforeTx !== expectedDetalleCount) {
            return json(
                {
                    ok: false,
                    error: "detalles_not_available",
                    expected: expectedDetalleCount,
                    valid: validCountBeforeTx,
                    result: 0,
                    id_pago: 0,
                    idPago: 0,
                },
                409,
                req,
            );
        }

        const insufficient = await findInsufficientStock(
            ctx.tenantDb,
            idComanda,
            detalles,
        );

        if (insufficient) {
            return json(
                {
                    ok: false,
                    error: "insufficient_stock",
                    productoId: insufficient.productoId,
                    requested: insufficient.requested,
                    available: insufficient.available,
                    result: 0,
                    id_pago: 0,
                    idPago: 0,
                },
                409,
                req,
            );
        }

        const domainArgs: Record<string, any> = {
            id_comanda: idComanda,
            metodo,
            importe_total: importeTotalInput,
            id_usuario_cobrador: idUsuarioCobrador,
            id_trabajador_cobrador: idTrabajadorExplicit,
            detalles,
        };

        if (forcedIdPago > 0) {
            domainArgs.id_pago = forcedIdPago;
        }

        const cloudPayload = {
            op_id: opId,
            command_name: COMMAND_NAME,
            args: domainArgs,
        };

        const inSql = buildInPlaceholders(2, detalles.length);
        const inSqlForInsert = buildInPlaceholders(3, detalles.length);

        const steps: TxStep[] = [
            {
                kind: "value",
                saveAs: "mapped_trabajador",
                sql: `
                    SELECT ID_Trabajador
                    FROM Trabajadores
                    WHERE ID_Usuario = ?1
                    LIMIT 1;
                `,
                args: [idUsuarioCobrador],
            },
            {
                kind: "value",
                saveAs: "trabajador_from_comanda",
                sql: `
                    SELECT ID_Trabajador
                    FROM Comandas
                    WHERE ID_Comanda = ?1
                    LIMIT 1;
                `,
                args: [idComanda],
            },
            {
                kind: "value",
                saveAs: "trabajador_final",
                sql: `
                    SELECT COALESCE(?1, ?2, ?3);
                `,
                args: [
                    idTrabajadorExplicit,
                    sqlRef("mapped_trabajador"),
                    sqlRef("trabajador_from_comanda"),
                ],
            },
            {
                kind: "value",
                saveAs: "valid_count",
                sql: `
                    SELECT COUNT(*)
                    FROM Detalle_Comanda dc
                    WHERE dc.ID_Comanda = ?1
                      AND dc.ID_Detalle IN (${inSql})
                      AND NOT EXISTS (
                        SELECT 1
                        FROM Pago_Detalles pd
                        WHERE pd.ID_Detalle = dc.ID_Detalle
                      );
                `,
                args: [idComanda, ...detalles],
            },
            {
                kind: "value",
                saveAs: "importe_total",
                sql: `
                    SELECT ROUND(
                        IFNULL(
                            SUM(COALESCE(dc.Cantidad,1) * COALESCE(dc.Precio_Unitario,0)),
                            0
                        ),
                        2
                    )
                    FROM Detalle_Comanda dc
                    WHERE dc.ID_Comanda = ?1
                      AND dc.ID_Detalle IN (${inSql})
                      AND NOT EXISTS (
                        SELECT 1
                        FROM Pago_Detalles pd
                        WHERE pd.ID_Detalle = dc.ID_Detalle
                      );
                `,
                args: [idComanda, ...detalles],
            },
            {
                kind: "execute",
                sql: `
                    UPDATE Comandas
                    SET ID_Trabajador = COALESCE(
                        ID_Trabajador,
                        ?2
                    )
                    WHERE ID_Comanda = ?1;
                `,
                args: [idComanda, sqlRef("trabajador_final")],
            },
            {
                /*
                  Validación de stock atómica dentro de la transacción.
                  stock_ok = 1 si TODOS los productos inventariados entre los
                  detalles a cobrar tienen stock suficiente; 0 si alguno falta.
                  El cobro (Pagos / Pago_Detalles) se condiciona a stock_ok = 1,
                  de modo que un fallo de stock no deja nada escrito.
                */
                kind: "value",
                saveAs: "stock_ok",
                sql: `
                    SELECT CASE WHEN EXISTS (
                        SELECT 1
                        FROM (
                            SELECT
                                dc.ID_Producto AS pid,
                                SUM(CAST(COALESCE(dc.Cantidad, 1) AS REAL)) AS requested
                            FROM Detalle_Comanda dc
                            WHERE dc.ID_Comanda = ?1
                              AND dc.ID_Detalle IN (${inSql})
                              AND NOT EXISTS (
                                SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = dc.ID_Detalle
                              )
                              AND EXISTS (
                                SELECT 1 FROM Lotes_Producto lp WHERE lp.ID_Producto = dc.ID_Producto
                              )
                            GROUP BY dc.ID_Producto
                        ) req
                        WHERE req.requested > COALESCE((
                            SELECT SUM(CAST(COALESCE(lp.Stock_Disponible, 0) AS REAL))
                            FROM Lotes_Producto lp
                            WHERE lp.ID_Producto = req.pid
                        ), 0)
                    ) THEN 0 ELSE 1 END;
                `,
                args: [idComanda, ...detalles],
            },
        ];

        if (forcedIdPago > 0) {
            steps.push(
                {
                    kind: "execute",
                    sql: `
                        INSERT INTO Pagos (
                            ID_Pago,
                            ID_Comanda,
                            Fecha_Hora,
                            Metodo_Pago,
                            Importe_Total,
                            Tipo,
                            ID_Usuario_Cobrador,
                            ID_Trabajador_Cobrador
                        )
                        SELECT
                            ?1,
                            ?2,
                            datetime('now','localtime'),
                            ?3,
                            ?4,
                            'FRACCIONADO',
                            ?5,
                            ?6
                        WHERE COALESCE(?7, 0) = ?8
                          AND COALESCE(?9, 0) = 1
                        ON CONFLICT(ID_Pago) DO UPDATE SET
                            ID_Comanda = excluded.ID_Comanda,
                            Metodo_Pago = excluded.Metodo_Pago,
                            Importe_Total = excluded.Importe_Total,
                            Tipo = excluded.Tipo,
                            ID_Usuario_Cobrador = excluded.ID_Usuario_Cobrador,
                            ID_Trabajador_Cobrador = excluded.ID_Trabajador_Cobrador;
                    `,
                    args: [
                        forcedIdPago,
                        idComanda,
                        metodo,
                        sqlRef("importe_total"),
                        idUsuarioCobrador,
                        sqlRef("trabajador_final"),
                        sqlRef("valid_count"),
                        expectedDetalleCount,
                        sqlRef("stock_ok"),
                    ],
                },
                {
                    kind: "value",
                    saveAs: "id_pago",
                    sql: `
                        SELECT CASE
                            WHEN COALESCE(?1, 0) = ?3 AND COALESCE(?4, 0) = 1 THEN ?2
                            ELSE 0
                        END;
                    `,
                    args: [
                        sqlRef("valid_count"),
                        forcedIdPago,
                        expectedDetalleCount,
                        sqlRef("stock_ok"),
                    ],
                },
            );
        } else {
            steps.push(
                {
                    kind: "execute",
                    sql: `
                        INSERT INTO Pagos (
                            ID_Comanda,
                            Fecha_Hora,
                            Metodo_Pago,
                            Importe_Total,
                            Tipo,
                            ID_Usuario_Cobrador,
                            ID_Trabajador_Cobrador
                        )
                        SELECT
                            ?1,
                            datetime('now','localtime'),
                            ?2,
                            ?3,
                            'FRACCIONADO',
                            ?4,
                            ?5
                        WHERE COALESCE(?6, 0) = ?7
                          AND COALESCE(?8, 0) = 1;
                    `,
                    args: [
                        idComanda,
                        metodo,
                        sqlRef("importe_total"),
                        idUsuarioCobrador,
                        sqlRef("trabajador_final"),
                        sqlRef("valid_count"),
                        expectedDetalleCount,
                        sqlRef("stock_ok"),
                    ],
                },
                {
                    kind: "value",
                    saveAs: "id_pago",
                    sql: `
                        SELECT CASE
                            WHEN COALESCE(?1, 0) = ?2 AND COALESCE(?3, 0) = 1 THEN last_insert_rowid()
                            ELSE 0
                        END;
                    `,
                    args: [
                        sqlRef("valid_count"),
                        expectedDetalleCount,
                        sqlRef("stock_ok"),
                    ],
                },
            );
        }

        const { cte: stockCte } = buildStockConsumptionCte(detalles.length);
        const stockConsumeArgs = [idComanda, ...detalles, sqlRef("id_pago")];

        steps.push(
            {
                kind: "execute",
                sql: `
                    INSERT OR IGNORE INTO Pago_Detalles (ID_Pago, ID_Detalle)
                    SELECT ?1, dc.ID_Detalle
                    FROM Detalle_Comanda dc
                    WHERE COALESCE(?1, 0) > 0
                      AND dc.ID_Comanda = ?2
                      AND dc.ID_Detalle IN (${inSqlForInsert})
                      AND NOT EXISTS (
                        SELECT 1
                        FROM Pago_Detalles pd
                        WHERE pd.ID_Detalle = dc.ID_Detalle
                      );
                `,
                args: [sqlRef("id_pago"), idComanda, ...detalles],
            },
            {
                /*
                  Trazabilidad FEFO (VR-05): inserta el consumo por lote y detalle.
                  Solo aplica si id_pago > 0 (gate dentro del CTE), por lo que un
                  cobro abortado no deja consumos. ON CONFLICT protege ante el
                  improbable reintento de un mismo (ID_Detalle, ID_Lote).
                */
                kind: "execute",
                sql: `
                    ${stockCte}
                    INSERT INTO Lote_Consumos (ID_Detalle, ID_Lote, Cantidad)
                    SELECT id_detalle, id_lote, consumed
                    FROM alloc
                    WHERE consumed > 0
                    ON CONFLICT(ID_Detalle, ID_Lote) DO NOTHING;
                `,
                args: stockConsumeArgs,
            },
            {
                /*
                  Decremento de stock FEFO en la MISMA transacción que el cobro
                  (VR-01). Repite el CTE (no sobrevive entre statements) y resta
                  a cada lote la suma de lo consumido. El gate por id_pago y el
                  reparto acotado por el stock disponible evitan negativos.
                */
                kind: "execute",
                sql: `
                    ${stockCte}
                    UPDATE Lotes_Producto
                    SET Stock_Disponible = COALESCE(Stock_Disponible, 0) - COALESCE((
                        SELECT SUM(a.consumed)
                        FROM alloc a
                        WHERE a.id_lote = Lotes_Producto.ID_Lote
                    ), 0)
                    WHERE ID_Lote IN (SELECT DISTINCT id_lote FROM alloc);
                `,
                args: stockConsumeArgs,
            },
            {
                kind: "execute",
                sql: `
                    UPDATE Comandas
                    SET
                      Estado = CASE
                        WHEN (
                          SELECT COUNT(*)
                          FROM Detalle_Comanda dc
                          LEFT JOIN Pago_Detalles pd
                            ON pd.ID_Detalle = dc.ID_Detalle
                          WHERE dc.ID_Comanda = ?1
                            AND pd.ID_Detalle IS NULL
                        ) = 0
                        AND COALESCE(?2, 0) > 0
                        THEN 'Pagada'
                        ELSE Estado
                      END,
                      Total_Comanda = (
                        SELECT IFNULL(SUM(COALESCE(Cantidad,1) * COALESCE(Precio_Unitario,0)), 0)
                        FROM Detalle_Comanda
                        WHERE ID_Comanda = ?1
                      ),
                      Fecha_Hora_Cierre = CASE
                        WHEN (
                          SELECT COUNT(*)
                          FROM Detalle_Comanda dc
                          LEFT JOIN Pago_Detalles pd
                            ON pd.ID_Detalle = dc.ID_Detalle
                          WHERE dc.ID_Comanda = ?1
                            AND pd.ID_Detalle IS NULL
                        ) = 0
                        AND COALESCE(?2, 0) > 0
                        THEN datetime('now','localtime')
                        ELSE Fecha_Hora_Cierre
                      END
                    WHERE ID_Comanda = ?1;
                `,
                args: [idComanda, sqlRef("id_pago")],
            },
            {
                kind: "value",
                saveAs: "result_id_pago",
                sql: `SELECT ?1;`,
                args: [sqlRef("id_pago")],
            },
        );

        const idPago = await applyTenantHubTransaction<number>({
            env,
            tenantId: ctx.tenantId,
            opId,
            commandName: COMMAND_NAME,
            deviceId: ctx.deviceId,
            beginMode: "immediate",
            steps,
            resultKey: "result_id_pago",

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

        const finalId = asNumber(idPago, 0);

        if (finalId <= 0) {
            /*
              No se creó el pago. No se escribió ningún Pago, Pago_Detalles,
              consumo ni decremento (todo gateado por stock_ok / valid_count).

              Prioridad: si la causa real es falta de stock —p. ej. el stock
              cayó entre el pre-check y la transacción (stock_ok=0)— devolvemos
              insufficient_stock, NUNCA cobro_not_applied. cobro_not_applied
              queda solo para el resto de causas (líneas ya pagadas, mismatch de
              detalles, estado no cobrable). Re-diagnosticamos leyendo el stock
              actual de los detalles solicitados.
            */
            const insufficientAfter = await findInsufficientStock(
                ctx.tenantDb,
                idComanda,
                detalles,
            );

            if (insufficientAfter) {
                return json(
                    {
                        ok: false,
                        error: "insufficient_stock",
                        productoId: insufficientAfter.productoId,
                        requested: insufficientAfter.requested,
                        available: insufficientAfter.available,
                        result: 0,
                        id_pago: 0,
                        idPago: 0,
                    },
                    409,
                    req,
                );
            }

            return json(
                {
                    ok: false,
                    error: "cobro_not_applied",
                    result: 0,
                    id_pago: 0,
                    idPago: 0,
                },
                409,
                req,
            );
        }

        return json(
            {
                ok: true,
                result: finalId,
                id_pago: finalId,
                idPago: finalId,
            },
            200,
            req,
        );
    } catch (e: any) {
        return handleVrWriteError(req, e);
    }
}