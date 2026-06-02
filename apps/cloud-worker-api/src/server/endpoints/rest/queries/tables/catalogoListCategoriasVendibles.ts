// src/server/endpoints/rest/queries/tables/catalogoListCategoriasVendibles.ts
import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, unauthorized, serverError } from "../../../../utils/response";

async function runQueryFallback(db: Client, sqls: string[]) {
    let lastErr: any = null;

    for (const sql of sqls) {
        try {
            return await db.execute({ sql, args: [] });
        } catch (e: any) {
            lastErr = e;
        }
    }

    throw lastErr ?? new Error("catalogo_list_categorias_failed");
}

export async function handleCatalogoListCategoriasVendibles(
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

        const r = await runQueryFallback(db, [
            `
            SELECT
              ID_Categoria,
              Nombre,
              Ruta_Imagen,
              COALESCE(Pasa_Cocina, 0) AS Pasa_Cocina
            FROM Categorias_Producto
            WHERE COALESCE(Vendible, 1) = 1
            ORDER BY Nombre ASC;
            `,
            `
            SELECT
              ID_Categoria,
              Nombre,
              NULL AS Ruta_Imagen,
              COALESCE(Pasa_Cocina, 0) AS Pasa_Cocina
            FROM Categorias_Producto
            WHERE COALESCE(Vendible, 1) = 1
            ORDER BY Nombre ASC;
            `,
            `
            SELECT
              ID_Categoria,
              Nombre,
              Ruta_Imagen,
              COALESCE(Pasa_Cocina, 0) AS Pasa_Cocina
            FROM Categorias_Producto
            ORDER BY Nombre ASC;
            `,
            `
            SELECT
              ID_Categoria,
              Nombre,
              NULL AS Ruta_Imagen,
              0 AS Pasa_Cocina
            FROM Categorias_Producto
            ORDER BY Nombre ASC;
            `,
        ]);

        const out = (r.rows || []).map((row: any) => ({
            ID_Categoria: Number(row.ID_Categoria ?? row[0] ?? 0),
            Nombre: String(row.Nombre ?? row[1] ?? ""),
            Ruta_Imagen: row.Ruta_Imagen ?? row[2] ?? null,
            Pasa_Cocina: Number(row.Pasa_Cocina ?? row[3] ?? 0),
        }));

        return json(out, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}