// src/server/endpoints/rest/queries/tables/catalogoSearchProductosByNombre.ts
import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, unauthorized, serverError } from "../../../../utils/response";

async function readJsonSafe<T>(req: Request, fallback: T): Promise<T> {
    try {
        return (await req.json()) as T;
    } catch {
        return fallback;
    }
}

async function productosQuery(
    db: Client,
    sqls: string[],
    args: any[],
) {
    let lastErr: any = null;

    for (const sql of sqls) {
        try {
            return await db.execute({ sql, args });
        } catch (e: any) {
            lastErr = e;
        }
    }

    throw lastErr ?? new Error("catalogo_search_productos_failed");
}

export async function handleCatalogoSearchProductosByNombre(
    req: Request,
    env: any,
    dbCentral: Client,
): Promise<Response> {
    try {
        const ctx: any = await buildTenantContext(
            req,
            env,
            dbCentral,
            createDbClient,
        );
        const db: Client = (ctx.dbTenant ?? ctx.db ?? dbCentral) as Client;

        if (!ctx?.claims?.tenantId) {
            return unauthorized(req, "invalid_token_claims");
        }

        const body = await readJsonSafe(req, {
            q: "",
            query: "",
            texto: "",
        });

        const q = String(
            (body as any).q ??
            (body as any).query ??
            (body as any).texto ??
            "",
        )
            .trim()
            .toLowerCase();

        if (!q) {
            return json([], 200, req);
        }

        const needle = `%${q}%`;

        const r = await productosQuery(
            db,
            [
                `
                SELECT
                  p.ID_Producto,
                  p.ID_Categoria,
                  p.Nombre,
                  COALESCE(p.Precio_Venta, 0) AS Precio_Venta,
                  p.Ruta_Imagen
                FROM Productos p
                JOIN Categorias_Producto c
                  ON c.ID_Categoria = p.ID_Categoria
                WHERE LOWER(p.Nombre) LIKE ?1
                  AND COALESCE(c.Vendible, 1) = 1
                ORDER BY p.Nombre ASC
                LIMIT 200;
                `,
                `
                SELECT
                  p.ID_Producto,
                  p.ID_Categoria,
                  p.Nombre,
                  COALESCE(p.Precio_Venta, 0) AS Precio_Venta,
                  NULL AS Ruta_Imagen
                FROM Productos p
                JOIN Categorias_Producto c
                  ON c.ID_Categoria = p.ID_Categoria
                WHERE LOWER(p.Nombre) LIKE ?1
                  AND COALESCE(c.Vendible, 1) = 1
                ORDER BY p.Nombre ASC
                LIMIT 200;
                `,
                `
                SELECT
                  ID_Producto,
                  ID_Categoria,
                  Nombre,
                  COALESCE(Precio_Venta, 0) AS Precio_Venta,
                  Ruta_Imagen
                FROM Productos
                WHERE LOWER(Nombre) LIKE ?1
                ORDER BY Nombre ASC
                LIMIT 200;
                `,
                `
                SELECT
                  ID_Producto,
                  ID_Categoria,
                  Nombre,
                  COALESCE(Precio_Venta, 0) AS Precio_Venta,
                  NULL AS Ruta_Imagen
                FROM Productos
                WHERE LOWER(Nombre) LIKE ?1
                ORDER BY Nombre ASC
                LIMIT 200;
                `,
            ],
            [needle],
        );

        const out = (r.rows || []).map((row: any) => ({
            ID_Producto: Number(row.ID_Producto ?? row[0] ?? 0),
            ID_Categoria: Number(row.ID_Categoria ?? row[1] ?? 0),
            Nombre: String(row.Nombre ?? row[2] ?? ""),
            Precio_Venta: Number(row.Precio_Venta ?? row[3] ?? 0),
            Ruta_Imagen: row.Ruta_Imagen ?? row[4] ?? null,
        }));

        return json(out, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}