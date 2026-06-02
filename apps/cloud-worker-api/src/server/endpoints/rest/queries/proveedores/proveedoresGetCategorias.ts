import type { Client } from "@libsql/client/web";
import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { corsHeaders, serverError } from "../../../../utils/response";

export type CategoriaRow = {
    id_categoria: number;
    nombre: string;
    nombre_imagen: string | null;
    ruta_imagen: string | null;
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

function rawJson(req: Request, data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            ...corsHeaders(req),
            "content-type": "application/json; charset=utf-8",
        },
    });
}

export async function handleProveedoresGetCategorias(
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
                  Ruta_Imagen
                FROM Categorias_Producto
                ORDER BY Nombre ASC;
            `,
            args: [],
        });

        const categorias: CategoriaRow[] = ((r.rows || []) as any[]).map((row: any) => ({
            id_categoria: Number(row.ID_Categoria ?? row[0] ?? 0),
            nombre: String(row.Nombre ?? row[1] ?? ""),
            nombre_imagen:
                row.Nombre_Imagen == null ? null : String(row.Nombre_Imagen),
            ruta_imagen:
                row.Ruta_Imagen == null ? null : String(row.Ruta_Imagen),
        }));

        return rawJson(req, categorias, 200);
    } catch (e: any) {
        return serverError(req, "internal_error", {
            message: String(e?.message || e),
            name: e?.name,
            stack: e?.stack,
        });
    }
}