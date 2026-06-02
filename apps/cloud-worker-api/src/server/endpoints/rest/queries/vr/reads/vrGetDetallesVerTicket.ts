// src/server/endpoints/rest/queries/ventaRapida/vrGetDetallesVerTicket.ts
import type { Client } from "@libsql/client/web";
import { buildTenantContext } from "../../../../../middleware/withTenant";
import { createDbClient } from "../../../../../db/clients";
import { json, serverError } from "../../../../../utils/response";

export type VerTicketsDetalleRow = {
    ID_Detalle: number;
    ID_Producto: number;
    Nombre: string;
    Cantidad: number;
    Precio_Unitario: number;
    Estado_Cocina: string;
    Pagado: number; // 0|1
    Notas: string | null;
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

export async function handleVrGetDetallesVerTicket(
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

        const body = await readJsonSafe(req, { idComanda: 0 });
        const idComanda = Number((body as any).idComanda || 0);
        if (!(idComanda > 0)) return json({ ok: true, detalles: [] }, 200, req);

        const r = await db.execute({
            sql: `
        SELECT
          dc.ID_Detalle,
          dc.ID_Producto,
          COALESCE(p.Nombre,'Producto') AS Nombre,
          COALESCE(dc.Cantidad,1) AS Cantidad,
          COALESCE(dc.Precio_Unitario,0) AS Precio_Unitario,
          COALESCE(dc.Estado_Cocina,'PENDIENTE') AS Estado_Cocina,
          CASE WHEN EXISTS (SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = dc.ID_Detalle)
               THEN 1 ELSE 0 END AS Pagado,
          dc.Notas
        FROM Detalle_Comanda dc
        LEFT JOIN Productos p ON p.ID_Producto = dc.ID_Producto
        WHERE dc.ID_Comanda = ?1
        ORDER BY dc.ID_Detalle ASC;
      `,
            args: [idComanda],
        });

        const out: VerTicketsDetalleRow[] = (r.rows || []).map((row: any) => ({
            ID_Detalle: Number(row.ID_Detalle || 0),
            ID_Producto: Number(row.ID_Producto || 0),
            Nombre: String(row.Nombre || "Producto"),
            Cantidad: Number(row.Cantidad ?? 1),
            Precio_Unitario: Number(row.Precio_Unitario ?? 0),
            Estado_Cocina: String(row.Estado_Cocina || "PENDIENTE"),
            Pagado: Number(row.Pagado || 0),
            Notas: row.Notas ? String(row.Notas) : null,
        }));

        return json({ ok: true, detalles: out }, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", {
            message: String(e?.message || e),
        });
    }
}
