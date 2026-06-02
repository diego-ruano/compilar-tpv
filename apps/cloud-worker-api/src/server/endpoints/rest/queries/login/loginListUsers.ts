import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, unauthorized, serverError } from "../../../../utils/response";

async function assertHasTable(db: Client, table: string) {
    const has = await db.execute({
        sql: `SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1;`,
        args: [table],
    });

    if ((has.rows?.length ?? 0) === 0) {
        const tables = await db.execute({
            sql: `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;`,
            args: [],
        });

        const names = (tables.rows ?? [])
            .map((r: any) => String(r.name ?? ""))
            .filter(Boolean);

        throw new Error(`missing_table:${table}; tables=[${names.join(", ")}]`);
    }
}

export async function handleLoginListUsers(
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

        const db: Client = ctx.dbTenant;

        if (!ctx?.claims?.tenantId) {
            return unauthorized(req, "invalid_token_claims");
        }

        await assertHasTable(db, "Usuarios");
        await assertHasTable(db, "Roles");

        const r = await db.execute({
            sql: `
                SELECT
                    u.ID_Usuario AS id_usuario,
                    u.Nombre     AS nombre,
                    u.Apellido   AS apellido,
                    r.Nombre_Rol AS nombre_rol
                FROM Usuarios u
                JOIN Roles r ON r.ID_Rol = u.ID_Rol
                WHERE u.Estado = 'Activo'
                ORDER BY u.Nombre ASC;
            `,
            args: [],
        });

        const out = (r.rows ?? []).map((x: any) => ({
            id_usuario: Number(x.id_usuario ?? 0) | 0,
            nombre: String(x.nombre ?? ""),
            apellido: x.apellido == null ? null : String(x.apellido),
            nombre_rol: String(x.nombre_rol ?? "Sin rol"),
        }));

        return json(out, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}