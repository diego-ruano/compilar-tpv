import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, unauthorized } from "../../../../utils/response";

import { verifyPinPbkdf2 } from "./pinKdf";

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
        if (body.payload && typeof body.payload === "object") return body.payload as T;
        if (body.input && typeof body.input === "object") return body.input as T;
    }

    return (body ?? {}) as T;
}

type LoginUserBody = {
    idUsuario?: number;
    id_usuario?: number;
    pin?: string;
};

export async function handleLoginUser(
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

        const rawBody = await readJsonSafe<any>(req, {});
        const body = unwrapArgs<LoginUserBody>(rawBody);

        const idUsuario = Number(body?.idUsuario ?? body?.id_usuario ?? 0) | 0;
        const pin = String(body?.pin ?? "");

        if (idUsuario <= 0) {
            return json({ ok: false, error: "ID_Usuario inválido" }, 200, req);
        }

        const r = await db.execute({
            sql: `
				SELECT
					u.ID_Usuario      AS id_usuario,
					t.ID_Trabajador   AS id_trabajador,
					u.Nombre          AS nombre,
					u.Apellido        AS apellido,
					u.Email           AS email,
					u.Password_Hash   AS password_hash,
					u.Requiere_Setup  AS requiere_setup,
					r.Nombre_Rol      AS rol
				FROM Usuarios u
				JOIN Roles r ON r.ID_Rol = u.ID_Rol
				LEFT JOIN Trabajadores t ON t.ID_Usuario = u.ID_Usuario
				WHERE u.ID_Usuario = ?1
				  AND u.Estado = 'Activo'
				LIMIT 1;
			`,
            args: [idUsuario],
        });

        const row: any = r.rows?.[0];

        if (!row) {
            return json(
                { ok: false, error: "Usuario no encontrado o inactivo" },
                200,
                req,
            );
        }

        const storedHash = String(row.password_hash ?? "");

        if (!storedHash) {
            return json({ ok: false, error: "Password_Hash inválido" }, 200, req);
        }

        await verifyPinPbkdf2(pin, storedHash);

        const out = {
            id_usuario: Number(row.id_usuario ?? 0) | 0,
            id_trabajador:
                row.id_trabajador == null ? null : Number(row.id_trabajador) | 0,
            nombre: String(row.nombre ?? ""),
            apellido: row.apellido == null ? null : String(row.apellido),
            rol: String(row.rol ?? "Sin rol"),
            email: String(row.email ?? "admin@local"),
            requiere_setup: Number(row.requiere_setup ?? 0) | 0,
        };

        return json({ ok: true, data: out }, 200, req);
    } catch (e: any) {
        const msg = String(e?.message || e);
        return json({ ok: false, error: msg }, 200, req);
    }
}