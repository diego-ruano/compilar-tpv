// src/server/endpoints/rest/queries/tasks/tareasGetTareaAsignados.ts
import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, unauthorized, serverError } from "../../../../utils/response";

async function readJsonSafe<T>(req: Request, fallback: T): Promise<T> {
    try {
        return (await req.json()) as T;
    } catch {
        return fallback;
    }
}

function vNum(x: any): number {
    const n = Number(x ?? 0);
    return Number.isFinite(n) ? n : 0;
}
function vStr(x: any): string {
    return String(x ?? "").trim();
}

export async function handleTareasGetTareaAsignados(
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

        const body = await readJsonSafe(req, { idTarea: 0 });
        const idTarea = vNum((body as any).idTarea ?? (body as any).id_tarea);
        if (!idTarea) return json({ ok: false }, 400, req);

        const r = await db.execute({
            sql: `
        SELECT
          a.ID_Trabajador,
          u.Nombre,
          u.Apellido,
          t.Puesto,
          a.Asignada_At,
          a.Estado,
          a.Finalizada_At
        FROM Tarea_Asignaciones a
        JOIN Trabajadores t ON t.ID_Trabajador = a.ID_Trabajador
        JOIN Usuarios u ON u.ID_Usuario = t.ID_Usuario
        WHERE a.ID_Tarea = ?1
        ORDER BY u.Nombre ASC;
      `,
            args: [idTarea],
        });

        const out = (r.rows ?? []).map((row: any) => ({
            ID_Trabajador: vNum(row.ID_Trabajador),
            Nombre: vStr(row.Nombre),
            Apellido: row.Apellido == null ? null : vStr(row.Apellido),
            Puesto: row.Puesto == null ? null : vStr(row.Puesto),
            Asignada_At: vStr(row.Asignada_At),
            Estado: vStr(row.Estado || "PENDIENTE"),
            Finalizada_At:
                row.Finalizada_At == null ? null : vStr(row.Finalizada_At),
        }));

        return json(out, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}
