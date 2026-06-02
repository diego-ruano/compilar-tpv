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

type IdCategoriaArgs = { id_categoria: number };

export async function handleInventarioListProductosByCategoria(
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

        const body = await readJsonSafe<IdCategoriaArgs>(req, {
            id_categoria: 0,
        });
        const idCategoria = Number(body?.id_categoria || 0);
        if (!Number.isFinite(idCategoria) || idCategoria <= 0) {
            return json({ ok: false, error: "bad_id_categoria" }, 400, req);
        }

        const r = await db.execute({
            sql: `
        SELECT
          p.ID_Producto,
          p.ID_Categoria,
          p.ID_Proveedor,
          p.Nombre,
          p.Precio_Venta,

          (
            SELECT COALESCE(SUM(l.Stock_Disponible), 0)
            FROM Lotes_Producto l
            WHERE l.ID_Producto = p.ID_Producto
          ) AS Stock_Actual,

          p.Stock_Minimo,
          p.Unidad_Medida,
          p.Nombre_Imagen,
          p.Ruta_Imagen,

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
          ) AS Lote_Proximo,

          p.Cantidad_Pedido_Esperada
        FROM Productos p
        WHERE p.ID_Categoria = ?
        ORDER BY p.Nombre ASC;
      `,
            args: [idCategoria],
        });

        return json(r.rows || [], 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}
