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

export async function handleInventarioGetAlergenosProducto(
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

        const r = await db.execute({
            sql: `
        SELECT ID_Alergeno
        FROM Producto_Alergenos
        WHERE ID_Producto=?
        ORDER BY ID_Alergeno ASC;
      `,
            args: [idProducto],
        });

        const ids = (r.rows || [])
            .map((x: any) => Number(x?.ID_Alergeno || 0))
            .filter((n) => Number.isFinite(n) && n > 0);

        return json(ids, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}
