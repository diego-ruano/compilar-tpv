// src/server/endpoints/rest/queries/bills/billsGetSalidas.ts
import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, unauthorized, serverError } from "../../../../utils/response";

function s(v: any): string {
    return String(v ?? "").trim();
}
function nI(v: any): number {
    const x = Number(v ?? 0);
    return Number.isFinite(x) ? Math.trunc(x) : 0;
}
function nF(v: any): number {
    const x = Number(v ?? 0);
    return Number.isFinite(x) ? x : 0;
}

async function readJsonSafe<T>(req: Request, fallback: T): Promise<T> {
    try {
        return (await req.json()) as T;
    } catch {
        return fallback;
    }
}

export async function handleBillsGetSalidas(
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

        const body = await readJsonSafe(req, {
            del: null as string | null,
            al: null as string | null,
        });
        const del = s((body as any).del);
        const al = s((body as any).al);

        const whereParts: string[] = [];
        const args: any[] = [];

        const hasDel = !!del;
        const hasAl = !!al;

        if (hasDel) {
            whereParts.push("date(Fecha) >= date(?1)");
            args.push(del);
        }

        const alIndex = hasDel ? 2 : 1;
        if (hasAl) {
            whereParts.push(`date(Fecha) <= date(?${alIndex})`);
            args.push(al);
        }

        const whereSql = whereParts.length
            ? `WHERE ${whereParts.join(" AND ")}`
            : "";

        const sql = `
      SELECT
        ID_Gasto AS id,
        substr(Fecha, 1, 10) AS fechaHora,
        Tipo_Gasto AS tipoGasto,
        Concepto AS concepto,
        Importe AS importe,
        ID_Proveedor AS proveedorId
      FROM Cuentas_Gastos
      ${whereSql}
      ORDER BY date(Fecha) DESC, ID_Gasto DESC;
    `;

        const r = await db.execute({ sql, args });

        const out = (r.rows ?? []).map((row: any) => ({
            id: String(nI(row.id)),
            fechaHora: s(row.fechaHora).slice(0, 10),
            tipoGasto: s(row.tipoGasto),
            concepto: s(row.concepto),
            importe: nF(row.importe),
            proveedorId: row.proveedorId == null ? null : nI(row.proveedorId),
        }));

        return json(out, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}
