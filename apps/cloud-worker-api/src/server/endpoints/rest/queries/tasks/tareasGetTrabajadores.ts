// src/server/endpoints/rest/queries/tasks/tareasGetTrabajadores.ts
import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, unauthorized, serverError } from "../../../../utils/response";

function vNum(x: any): number {
    const n = Number(x ?? 0);
    return Number.isFinite(n) ? n : 0;
}
function vStr(x: any): string {
    return String(x ?? "").trim();
}

export async function handleTareasGetTrabajadores(
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

        if (!ctx?.claims?.tenantId)
            return unauthorized(req, "invalid_token_claims");

        const r = await db.execute({
            sql: `
        SELECT
          t.ID_Trabajador,
          t.ID_Usuario,
          u.Nombre,
          u.Apellido,
          t.Puesto,
          u.Email
        FROM Trabajadores t
        JOIN Usuarios u ON u.ID_Usuario = t.ID_Usuario
        WHERE u.Estado = 'Activo'
        ORDER BY u.Nombre ASC;
      `,
            args: [],
        });

        const out = (r.rows ?? []).map((row: any) => ({
            ID_Trabajador: vNum(row.ID_Trabajador),
            ID_Usuario: vNum(row.ID_Usuario),
            Nombre: vStr(row.Nombre),
            Apellido: row.Apellido == null ? null : vStr(row.Apellido),
            Puesto: row.Puesto == null ? null : vStr(row.Puesto),
            Email: vStr(row.Email),
        }));

        return json(out, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}
