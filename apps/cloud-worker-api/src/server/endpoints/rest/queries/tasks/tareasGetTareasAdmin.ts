// src/server/endpoints/rest/queries/tasks/tareasGetTareasAdmin.ts
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

export async function handleTareasGetTareasAdmin(
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
          t.ID_Tarea,
          t.Titulo,
          t.Descripcion,
          t.Fecha_Creacion,
          t.Fecha_Limite,
          (
            SELECT COUNT(*)
            FROM Tarea_Asignaciones a
            WHERE a.ID_Tarea = t.ID_Tarea
          ) AS Total_Asignados,
          (
            SELECT COUNT(*)
            FROM Tarea_Asignaciones a
            WHERE a.ID_Tarea = t.ID_Tarea
              AND a.Estado = 'FINALIZADA'
          ) AS Total_Finalizadas
        FROM Tareas t
        WHERE t.Estado = 'ABIERTA'
        ORDER BY t.ID_Tarea DESC;
      `,
            args: [],
        });

        const out = (r.rows ?? []).map((row: any) => ({
            ID_Tarea: vNum(row.ID_Tarea),
            Titulo: vStr(row.Titulo),
            Descripcion: row.Descripcion == null ? null : vStr(row.Descripcion),
            Fecha_Creacion: vStr(row.Fecha_Creacion),
            Fecha_Limite:
                row.Fecha_Limite == null ? null : vStr(row.Fecha_Limite),
            Total_Asignados: vNum(row.Total_Asignados),
            Total_Finalizadas: vNum(row.Total_Finalizadas),
        }));

        return json(out, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}
