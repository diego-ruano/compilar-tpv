import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, serverError } from "../../../../utils/response";

async function readJsonSafe<T>(req: Request, fallback: T): Promise<T> {
    try {
        return (await req.json()) as T;
    } catch {
        return fallback;
    }
}

function getTenantDb(ctx: any): Client {
    return (ctx?.dbTenant || ctx?.db || ctx?.tenantDb) as Client;
}

type SummaryArgs = { limit?: number };

export async function handleInventarioGetResumen(
    req: Request,
    env: any,
    dbCentral: Client,
): Promise<Response> {
    try {
        const ctx = await buildTenantContext(
            req,
            env,
            dbCentral,
            createDbClient,
        );
        const db = getTenantDb(ctx);

        const body = await readJsonSafe<SummaryArgs>(req, { limit: 12 });
        const limit = Math.max(
            1,
            Math.min(200, Number(body?.limit ?? 12) || 12),
        );

        const cad = await db.execute({
            sql: `
        SELECT
          p.Nombre AS Nombre,
          l.Stock_Disponible AS Stock_Actual,
          p.Unidad_Medida AS Unidad_Medida,
          l.Caducidad AS Caducidad_Proxima,
          l.Codigo_Lote AS Lote,
          p.Precio_Venta AS Precio_Venta
        FROM Lotes_Producto l
        JOIN Productos p ON p.ID_Producto = l.ID_Producto
        WHERE l.Stock_Disponible > 0
          AND l.Caducidad IS NOT NULL
        ORDER BY date(l.Caducidad) ASC, datetime(l.Fecha_Entrada) ASC, l.ID_Lote ASC
        LIMIT ?;
      `,
            args: [limit],
        });

        const low = await db.execute({
            sql: `
        WITH base AS (
          SELECT
            p.ID_Producto,
            p.Nombre,
            p.Unidad_Medida,
            p.Precio_Venta,
            (
              SELECT COALESCE(SUM(l.Stock_Disponible), 0)
              FROM Lotes_Producto l
              WHERE l.ID_Producto = p.ID_Producto
            ) AS Stock_Actual,
            (
              SELECT l.Caducidad
              FROM Lotes_Producto l
              WHERE l.ID_Producto = p.ID_Producto
                AND l.Stock_Disponible > 0
                AND l.Caducidad IS NOT NULL
              ORDER BY date(l.Caducidad) ASC, datetime(l.Fecha_Entrada) ASC, l.ID_Lote ASC
              LIMIT 1
            ) AS Caducidad_Proxima,
            (
              SELECT l.Codigo_Lote
              FROM Lotes_Producto l
              WHERE l.ID_Producto = p.ID_Producto
                AND l.Stock_Disponible > 0
                AND l.Caducidad IS NOT NULL
              ORDER BY date(l.Caducidad) ASC, datetime(l.Fecha_Entrada) ASC, l.ID_Lote ASC
              LIMIT 1
            ) AS Lote
          FROM Productos p
        )
        SELECT
          Nombre,
          Stock_Actual,
          Unidad_Medida,
          Caducidad_Proxima,
          Lote,
          Precio_Venta
        FROM base
        ORDER BY Stock_Actual ASC, Nombre ASC
        LIMIT ?;
      `,
            args: [limit],
        });

        return json(
            {
                proximosCaducar: cad.rows || [],
                menosCantidad: low.rows || [],
            },
            200,
            req,
        );
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}
