// src/server/endpoints/rest/queries/tasks/tareasGetTareaById.ts
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

export async function handleTareasGetTareaById(
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
        SELECT ID_Tarea, Titulo, Descripcion, Fecha_Creacion, Fecha_Limite
        FROM Tareas
        WHERE ID_Tarea = ?1
        LIMIT 1;
      `,
            args: [idTarea],
        });

        const row: any | undefined = (r.rows ?? [])[0] as any;
        if (!row) return json(null, 200, req);

        return json(
            {
                ID_Tarea: vNum(row.ID_Tarea),
                Titulo: vStr(row.Titulo),
                Descripcion:
                    row.Descripcion == null ? null : vStr(row.Descripcion),
                Fecha_Creacion: vStr(row.Fecha_Creacion),
                Fecha_Limite:
                    row.Fecha_Limite == null ? null : vStr(row.Fecha_Limite),
            },
            200,
            req,
        );
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}
