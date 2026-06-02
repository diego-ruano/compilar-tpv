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

export async function handleInventarioGetProductoDetalle(
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

        const prod = await db.execute({
            sql: `
        SELECT
          ID_Producto,
          ID_Categoria,
          ID_Proveedor,
          Nombre,
          Precio_Venta,
          Stock_Minimo,
          Unidad_Medida,
          Nombre_Imagen,
          Ruta_Imagen,
          Cantidad_Pedido_Esperada
        FROM Productos
        WHERE ID_Producto=?
        LIMIT 1;
      `,
            args: [idProducto],
        });

        const producto = (prod.rows || [])[0];
        if (!producto) return json(null, 200, req);

        const alergs = await db.execute({
            sql: `
        SELECT a.ID_Alergeno, a.Nombre, a.Ruta_Imagen
        FROM Producto_Alergenos pa
        JOIN Alergenos a ON a.ID_Alergeno = pa.ID_Alergeno
        WHERE pa.ID_Producto=?
        ORDER BY a.Nombre ASC;
      `,
            args: [idProducto],
        });

        return json({ producto, alergs: alergs.rows || [] }, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}
