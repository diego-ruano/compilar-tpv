// src/server/endpoints/rest/queries/bills/billsGetEntradas.ts
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

export async function handleBillsGetEntradas(
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
            whereParts.push("date(p.Fecha_Hora) >= date(?1)");
            args.push(del);
        }

        const alIndex = hasDel ? 2 : 1;
        if (hasAl) {
            whereParts.push(`date(p.Fecha_Hora) <= date(?${alIndex})`);
            args.push(al);
        }

        const whereSql = whereParts.length
            ? `WHERE ${whereParts.join(" AND ")}`
            : "";

        const sql = `
      SELECT
        p.ID_Pago AS id,
        substr(p.Fecha_Hora, 1, 16) AS fechaHora,
        (
          (
            CASE
              WHEN m.Numero_Mesa = 'BARRA' THEN 'Take away'
              WHEN m.Numero_Mesa IS NOT NULL AND m.Numero_Mesa <> '' THEN 'Mesa ' || m.Numero_Mesa
              ELSE 'Venta'
            END
          )
          ||
          CASE
            WHEN cl.Nombre IS NOT NULL AND cl.Nombre <> '' THEN ' / ' || cl.Nombre
            ELSE ''
          END
        ) AS cliente,
        CASE
          WHEN p.Metodo_Pago = 'Tarjeta' THEN 'Tarjeta'
          ELSE 'Efectivo'
        END AS metodo,
        IFNULL(p.Importe_Total, 0) AS importe
      FROM Pagos p
      JOIN Comandas c ON c.ID_Comanda = p.ID_Comanda
      LEFT JOIN Mesas m ON m.ID_Mesa = c.ID_Mesa
      LEFT JOIN Reservas r ON r.ID_Reserva = c.ID_Reserva
      LEFT JOIN Clientes cl ON cl.ID_Cliente = r.ID_Cliente
      ${whereSql}
      ORDER BY p.Fecha_Hora DESC, p.ID_Pago DESC;
    `;

        const r = await db.execute({ sql, args });

        const out = (r.rows ?? []).map((row: any) => ({
            id: String(nI(row.id)),
            fechaHora: s(row.fechaHora).slice(0, 16),
            cliente: s(row.cliente),
            metodo: s(row.metodo) || "Efectivo",
            importe: nF(row.importe),
        }));

        return json(out, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}
