// src/server/endpoints/rest/queries/tables/mesasGetOcupadas.ts
import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, unauthorized, serverError } from "../../../../utils/response";

export async function handleMesasGetOcupadas(
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
        SELECT M.ID_Zona, C.ID_Mesa
        FROM Comandas C
        JOIN Mesas M ON M.ID_Mesa = C.ID_Mesa
        WHERE C.Estado = 'Abierta';
      `,
            args: [],
        });

        const map: Record<string, boolean> = {};
        for (const row of (r.rows || []) as any[]) {
            const idZona = Number(row.ID_Zona ?? row[0] ?? 0);
            const idMesa = Number(row.ID_Mesa ?? row[1] ?? 0);
            if (!idZona || !idMesa) continue;
            map[`db-zona-${idZona}:db-mesa-${idMesa}`] = true;
        }

        return json(map, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}
