// src/server/endpoints/rest/queries/ventaRapida/vrSearchProductos.ts
import type { Client } from "@libsql/client/web";
import { buildTenantContext } from "../../../../../middleware/withTenant";
import { createDbClient } from "../../../../../db/clients";
import { json, serverError } from "../../../../../utils/response";

export type ProductoRow = {
    ID_Producto: number;
    ID_Categoria: number;
    Nombre: string;
    Precio_Venta: number;
    Stock_Actual: number;
    Stock_Minimo: number;
    Unidad_Medida: string | null;
    Nombre_Imagen: string | null;
    Ruta_Imagen: string | null;
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

export async function handleVrSearchProductos(
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

        const body = await readJsonSafe(req, { query: "", limit: 60 });
        const q = String((body as any).query || "").trim();
        const limitRaw = Number((body as any).limit ?? 60);
        if (!q) return json({ ok: true, productos: [] }, 200, req);

        const lim = limitRaw > 0 ? Math.floor(limitRaw) : 60;
        const like = `%${q}%`;

        const r = await db.execute({
            sql: `
        SELECT
          p.ID_Producto,
          p.ID_Categoria,
          p.Nombre,
          COALESCE(p.Precio_Venta,0) AS Precio_Venta,
          COALESCE(v.Stock_Actual,0) AS Stock_Actual,
          COALESCE(p.Stock_Minimo,0) AS Stock_Minimo,
          p.Unidad_Medida,
          p.Nombre_Imagen,
          p.Ruta_Imagen
        FROM Productos p
        JOIN Categorias_Producto c ON c.ID_Categoria = p.ID_Categoria
        LEFT JOIN v_inventario_producto_stock v ON v.ID_Producto = p.ID_Producto
        WHERE p.Nombre LIKE ?1
          AND COALESCE(c.Vendible,1)=1
        ORDER BY p.Nombre ASC
        LIMIT ?2;
      `,
            args: [like, lim],
        });

        const out: ProductoRow[] = (r.rows || []).map((row: any) => ({
            ID_Producto: Number(row.ID_Producto || 0),
            ID_Categoria: Number(row.ID_Categoria || 0),
            Nombre: String(row.Nombre || ""),
            Precio_Venta: Number(row.Precio_Venta || 0),
            Stock_Actual: Number(row.Stock_Actual || 0),
            Stock_Minimo: Number(row.Stock_Minimo || 0),
            Unidad_Medida: row.Unidad_Medida ? String(row.Unidad_Medida) : null,
            Nombre_Imagen: row.Nombre_Imagen ? String(row.Nombre_Imagen) : null,
            Ruta_Imagen: row.Ruta_Imagen ? String(row.Ruta_Imagen) : null,
        }));

        return json({ ok: true, productos: out }, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", {
            message: String(e?.message || e),
        });
    }
}
