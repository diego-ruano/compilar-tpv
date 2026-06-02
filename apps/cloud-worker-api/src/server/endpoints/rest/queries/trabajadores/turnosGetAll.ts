import type { Client } from "@libsql/client/web";
import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, serverError } from "../../../../utils/response";

export type TurnoRow = {
    ID_Turno: number;
    Nombre_Turno: string;
};

function pickTenantDb(ctx: any): Client {
    const db =
        (ctx?.dbTenant as Client) ||
        (ctx?.db as Client) ||
        (ctx?.tenantDb as Client) ||
        (ctx?.client as Client);
    if (!db) throw new Error("tenant_db_missing");
    return db;
}

export async function handleTurnosGetAll(
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

        const r = await db.execute({
            sql: `
                SELECT ID_Turno, Nombre_Turno
                FROM Turnos
                ORDER BY
                  CASE WHEN Nombre_Turno = 'LIBRE' THEN 0 ELSE 1 END,
                  Nombre_Turno ASC,
                  ID_Turno ASC;
            `,
            args: [],
        });

        const out: TurnoRow[] = (r.rows || []).map((row: any) => ({
            ID_Turno: Number(row.ID_Turno || 0),
            Nombre_Turno: String(row.Nombre_Turno || ""),
        }));

        return json(out, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", {
            message: String(e?.message || e),
            name: e?.name,
            stack: e?.stack,
        });
    }
}