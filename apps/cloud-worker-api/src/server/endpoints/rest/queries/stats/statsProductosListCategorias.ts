// src/server/endpoints/rest/queries/stats/statsProductosListCategorias.ts
import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, unauthorized, serverError } from "../../../../utils/response";

function nI(v: any): number {
    const x = Number(v ?? 0);
    return Number.isFinite(x) ? Math.trunc(x) : 0;
}
function s(v: any): string {
    return String(v ?? "").trim();
}

export async function handleStatsProductosListCategorias(
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
        SELECT ID_Categoria, Nombre
        FROM Categorias_Producto
        WHERE COALESCE(Vendible,1)=1
        ORDER BY Nombre ASC;
      `,
            args: [],
        });

        const out = (r.rows ?? []).map((row: any) => ({
            ID_Categoria: nI(row.ID_Categoria),
            Nombre: s(row.Nombre),
        }));

        return json(out, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}
