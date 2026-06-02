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
type IdProductoArgs = { id_producto: number };

export async function handleInventarioListLotesByProducto(
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

        const body = await readJsonSafe<IdProductoArgs>(req, {
            id_producto: 0,
        });
        const idProducto = Number(body?.id_producto || 0);
        if (!Number.isFinite(idProducto) || idProducto <= 0)
            return json({ ok: false, error: "bad_id_producto" }, 400, req);

        const r = await db.execute({
            sql: `
        SELECT
          ID_Lote,
          ID_Producto,
          Codigo_Lote,
          Fecha_Entrada,
          Caducidad,
          Cantidad_Inicial,
          Stock_Disponible,
          Coste_Unitario,
          ID_Proveedor,
          Notas
        FROM Lotes_Producto
        WHERE ID_Producto=?
        ORDER BY
          (Caducidad IS NULL) ASC,
          date(Caducidad) ASC,
          datetime(Fecha_Entrada) DESC,
          ID_Lote DESC;
      `,
            args: [idProducto],
        });

        return json(r.rows || [], 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}
