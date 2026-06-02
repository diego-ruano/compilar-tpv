// src/server/endpoints/rest/queries/ventaRapida/vrGetIndexRows.ts
import type { Client } from "@libsql/client/web";
import { buildTenantContext } from "../../../../../middleware/withTenant";
import { createDbClient } from "../../../../../db/clients";
import { json, serverError } from "../../../../../utils/response";

export type IndexRow = {
    ID_Comanda: number;
    Productos: string | null;
    NumLineas: number;
    Unidades: number;
};

async function readJsonSafe<T>(req: Request, fallback: T): Promise<T> {
    try {
        return (await req.json()) as T;
    } catch {
        return fallback;
    }
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

export async function handleVrGetIndexRows(
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
        const db = pickTenantDb(ctx);

        const body = await readJsonSafe(req, { ids: [] as number[] });
        const ids = (Array.isArray((body as any).ids) ? (body as any).ids : [])
            .map((n: any) => Number(n || 0))
            .filter((n: number) => n > 0);

        if (ids.length === 0) return json({ ok: true, rows: [] }, 200, req);

        const placeholders = ids.map(() => "?").join(",");
        const sql = `
      SELECT
        x.ID_Comanda AS ID_Comanda,

        (
          SELECT GROUP_CONCAT(nn.Nombre, ' · ')
          FROM (
            SELECT DISTINCT COALESCE(p2.Nombre,'') AS Nombre
            FROM Detalle_Comanda dc2
            LEFT JOIN Productos p2 ON p2.ID_Producto = dc2.ID_Producto
            WHERE dc2.ID_Comanda = x.ID_Comanda
            ORDER BY COALESCE(p2.Nombre,'')
          ) nn
          WHERE nn.Nombre <> ''
        ) AS Productos,

        x.NumLineas AS NumLineas,
        x.Unidades AS Unidades
      FROM (
        SELECT
          dc.ID_Comanda AS ID_Comanda,
          COUNT(*) AS NumLineas,
          COALESCE(SUM(COALESCE(dc.Cantidad,1)),0) AS Unidades
        FROM Detalle_Comanda dc
        WHERE dc.ID_Comanda IN (${placeholders})
        GROUP BY dc.ID_Comanda
      ) x;
    `;

        const r = await db.execute({ sql, args: ids });

        const out: IndexRow[] = (r.rows || []).map((row: any) => {
            const productosRaw =
                row.Productos === null || row.Productos === undefined
                    ? null
                    : String(row.Productos).trim();
            return {
                ID_Comanda: Number(row.ID_Comanda || 0),
                Productos:
                    productosRaw && productosRaw.length ? productosRaw : null,
                NumLineas: Number(row.NumLineas || 0),
                Unidades: Number(row.Unidades || 0),
            };
        });

        return json({ ok: true, rows: out }, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", {
            message: String(e?.message || e),
        });
    }
}
