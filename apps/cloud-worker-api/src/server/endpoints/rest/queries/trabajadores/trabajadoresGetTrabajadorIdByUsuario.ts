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

function unwrapArgs<T>(body: any): T {
    if (body && typeof body === "object") {
        if (body.args && typeof body.args === "object") return body.args as T;
        if (body.payload && typeof body.payload === "object")
            return body.payload as T;
        if (body.input && typeof body.input === "object") return body.input as T;
    }
    return body as T;
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

export async function handleTrabajadoresGetTrabajadorIdByUsuario(
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

        const bodyRaw = await readJsonSafe(req, { idUsuario: 0 });
        const body = unwrapArgs<any>(bodyRaw);

        const idUsuario = Number(
            body?.idUsuario ?? body?.id_usuario ?? 0,
        );

        if (!Number.isFinite(idUsuario) || idUsuario <= 0) {
            return json(null, 200, req);
        }

        const r = await db.execute({
            sql: `
                SELECT ID_Trabajador
                FROM Trabajadores
                WHERE ID_Usuario = ?1
                LIMIT 1;
            `,
            args: [idUsuario],
        });

        const idTrab = Number((r.rows?.[0] as any)?.ID_Trabajador || 0);
        return json(idTrab > 0 ? idTrab : null, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", {
            message: String(e?.message || e),
            name: e?.name,
            stack: e?.stack,
        });
    }
}