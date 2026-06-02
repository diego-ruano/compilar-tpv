// src/server/endpoints/rest/queries/ventaRapida/vrListCategoriasVendibles.ts
import type { Client } from "@libsql/client/web";
import { buildTenantContext } from "../../../../../middleware/withTenant";
import { createDbClient } from "../../../../../db/clients";
import { json, serverError } from "../../../../../utils/response";

export type CategoriaRow = {
    ID_Categoria: number;
    Nombre: string;
    Nombre_Imagen: string | null;
    Ruta_Imagen: string | null;
    Vendible: number | null;
};

function pickTenantDb(ctx: any): Client {
    const db =
        (ctx?.dbTenant as Client) ||
        (ctx?.db as Client) ||
        (ctx?.tenantDb as Client) ||
        (ctx?.client as Client);
    if (!db) throw new Error("tenant_db_missing");
    return db;
}

export async function handleVrListCategoriasVendibles(
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

        const r = await db.execute({
            sql: `
        SELECT
          ID_Categoria,
          Nombre,
          Nombre_Imagen,
          Ruta_Imagen,
          Vendible
        FROM Categorias_Producto
        WHERE COALESCE(Vendible,1)=1
        ORDER BY Nombre ASC;
      `,
            args: [],
        });

        const out: CategoriaRow[] = (r.rows || []).map((row: any) => ({
            ID_Categoria: Number(row.ID_Categoria || 0),
            Nombre: String(row.Nombre || ""),
            Nombre_Imagen: row.Nombre_Imagen ? String(row.Nombre_Imagen) : null,
            Ruta_Imagen: row.Ruta_Imagen ? String(row.Ruta_Imagen) : null,
            Vendible:
                row.Vendible === null || row.Vendible === undefined
                    ? null
                    : Number(row.Vendible),
        }));

        return json({ ok: true, categorias: out }, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", {
            message: String(e?.message || e),
        });
    }
}
