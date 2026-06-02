import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, serverError } from "../../../../utils/response";

function getTenantDb(ctx: any): Client {
    return (ctx?.dbTenant || ctx?.db || ctx?.tenantDb) as Client;
}

function toCategoriaRow(row: any) {
    return {
        ID_Categoria: Number(row?.ID_Categoria ?? 0),
        Nombre: String(row?.Nombre ?? ""),
        Nombre_Imagen: row?.Nombre_Imagen ? String(row.Nombre_Imagen) : "",
        Ruta_Imagen: row?.Ruta_Imagen ? String(row.Ruta_Imagen) : "",
        Vendible: Number(row?.Vendible ?? 0),
        Pasa_Cocina: Number(row?.Pasa_Cocina ?? 0),
    };
}

export async function handleInventarioListCategorias(
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

        const r = await db.execute({
            sql: `
                SELECT
                    ID_Categoria,
                    Nombre,
                    Nombre_Imagen,
                    Ruta_Imagen,
                    Vendible,
                    Pasa_Cocina
                FROM Categorias_Producto
                ORDER BY Nombre ASC
            `,
            args: [],
        });

        const rows = Array.isArray(r?.rows) ? r.rows.map(toCategoriaRow) : [];

        return json(rows, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}