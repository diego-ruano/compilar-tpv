// src/server/endpoints/rest/queries/tasks/tareasGetMisTareas.ts
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

export async function handleTareasGetMisTareas(
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

        const body = await readJsonSafe(req, { idTrabajador: 0 });
        const idTrabajador = vNum(
            (body as any).idTrabajador ?? (body as any).id_trabajador,
        );
        if (!idTrabajador) return json({ ok: false }, 400, req);

        const r = await db.execute({
            sql: `
        SELECT
          t.ID_Tarea,
          t.Titulo,
          t.Descripcion,
          t.Fecha_Limite,
          a.Asignada_At,
          a.Estado,
          a.Finalizada_At
        FROM Tarea_Asignaciones a
        JOIN Tareas t ON t.ID_Tarea = a.ID_Tarea
        WHERE a.ID_Trabajador = ?1
          AND t.Estado = 'ABIERTA'
          AND (
            a.Estado <> 'FINALIZADA'
            OR date(a.Finalizada_At) = date('now','localtime')
          )
        ORDER BY
          CASE WHEN a.Estado='PENDIENTE' THEN 0 ELSE 1 END,
          t.Fecha_Limite ASC,
          t.ID_Tarea DESC;
      `,
            args: [idTrabajador],
        });

        const out = (r.rows ?? []).map((row: any) => ({
            ID_Tarea: vNum(row.ID_Tarea),
            Titulo: vStr(row.Titulo),
            Descripcion: row.Descripcion == null ? null : vStr(row.Descripcion),
            Fecha_Limite:
                row.Fecha_Limite == null ? null : vStr(row.Fecha_Limite),
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
