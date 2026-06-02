// src/server/endpoints/rest/queries/ventaRapida/vrListProductosByCategoria.ts
import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../../middleware/withTenant";
import { createDbClient } from "../../../../../db/clients";
import { json, serverError, unauthorized } from "../../../../../utils/response";

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

type VrListProductosByCategoriaInput = {
    id_categoria: number;
};

async function readJsonSafe<T>(req: Request, fallback: T): Promise<T> {
    try {
        return (await req.json()) as T;
    } catch {
        return fallback;
    }
}

export async function handleVrListProductosByCategoria(
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

        const tenantId = String(ctx?.claims?.tenantId || "").trim();
        if (!tenantId) {
            return unauthorized(req, "invalid_token_claims");
        }

        const db = ctx.dbTenant as Client;
        if (!db) {
            throw new Error("tenant_db_missing");
        }

        const body = await readJsonSafe<VrListProductosByCategoriaInput>(req, {
            id_categoria: 0,
        });

        const idCategoria = Number(body.id_categoria || 0);

        if (!Number.isFinite(idCategoria) || idCategoria <= 0) {
            return json({ ok: true, result: [] }, 200, req);
        }

        const r = await db.execute({
            sql: `
                SELECT
                    p.ID_Producto,
                    p.ID_Categoria,
                    p.Nombre,
                    COALESCE(p.Precio_Venta, 0) AS Precio_Venta,
                    COALESCE(v.Stock_Actual, 0) AS Stock_Actual,
                    COALESCE(p.Stock_Minimo, 0) AS Stock_Minimo,
                    p.Unidad_Medida,
                    p.Nombre_Imagen,
                    p.Ruta_Imagen
                FROM Productos p
                JOIN Categorias_Producto c
                  ON c.ID_Categoria = p.ID_Categoria
                LEFT JOIN v_inventario_producto_stock v
                  ON v.ID_Producto = p.ID_Producto
                WHERE p.ID_Categoria = ?1
                  AND COALESCE(c.Vendible, 1) = 1
                ORDER BY p.Nombre ASC;
            `,
            args: [idCategoria],
        });

        const out: ProductoRow[] = (r.rows || []).map((row: any) => ({
            ID_Producto: Number(row.ID_Producto || 0),
            ID_Categoria: Number(row.ID_Categoria || 0),
            Nombre: String(row.Nombre || ""),
            Precio_Venta: Number(row.Precio_Venta || 0),
            Stock_Actual: Number(row.Stock_Actual || 0),
            Stock_Minimo: Number(row.Stock_Minimo || 0),
            Unidad_Medida:
                row.Unidad_Medida == null ? null : String(row.Unidad_Medida),
            Nombre_Imagen:
                row.Nombre_Imagen == null ? null : String(row.Nombre_Imagen),
            Ruta_Imagen:
                row.Ruta_Imagen == null ? null : String(row.Ruta_Imagen),
        }));

        return json({ ok: true, result: out }, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", {
            message: String(e?.message || e),
            name: e?.name,
            stack: e?.stack,
        });
    }
}