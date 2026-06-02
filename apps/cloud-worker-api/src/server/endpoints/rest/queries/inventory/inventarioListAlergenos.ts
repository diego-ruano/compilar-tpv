import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, serverError } from "../../../../utils/response";

function getTenantDb(ctx: any): Client {
    return (ctx?.dbTenant || ctx?.db || ctx?.tenantDb) as Client;
}

export async function handleInventarioListAlergenos(
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
        SELECT ID_Alergeno, Nombre, Nombre_Imagen, Ruta_Imagen
        FROM Alergenos
        ORDER BY Nombre ASC;
      `,
            args: [],
        });

        return json(r.rows || [], 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}
