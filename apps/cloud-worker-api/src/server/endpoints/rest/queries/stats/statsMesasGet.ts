import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, unauthorized, serverError } from "../../../../utils/response";

type StatsRange = "hoy" | "semana" | "mes" | "anio";

type StatsMesasInput = {
    range?: StatsRange;
};

async function readJsonSafe<T>(req: Request, fallback: T): Promise<T> {
    try {
        return (await req.json()) as T;
    } catch {
        return fallback;
    }
}

function unwrapArgs<T>(body: any): T {
    if (body && typeof body === "object") {
        if (body.args && typeof body.args === "object") return body.args as T;
        if (body.payload && typeof body.payload === "object") return body.payload as T;
        if (body.input && typeof body.input === "object") return body.input as T;
    }
    return body as T;
}

function normalizeRange(v: unknown): StatsRange {
    return v === "hoy" || v === "semana" || v === "mes" || v === "anio"
        ? v
        : "hoy";
}

function rangeBounds(range: StatsRange): { start: string; end: string } {
    switch (range) {
        case "hoy":
            return {
                start: "datetime('now','localtime','start of day')",
                end: "datetime('now','localtime')",
            };
        case "semana":
            return {
                start: "datetime('now','localtime','-6 days','start of day')",
                end: "datetime('now','localtime')",
            };
        case "mes":
            return {
                start: "datetime('now','localtime','start of month')",
                end: "datetime('now','localtime')",
            };
        case "anio":
        default:
            return {
                start: "datetime('now','localtime','start of year')",
                end: "datetime('now','localtime')",
            };
    }
}

function bucketPaidAt(range: StatsRange): string {
    switch (range) {
        case "hoy":
            return "strftime('%H', paid_at)";
        case "semana":
        case "mes":
            return "strftime('%d/%m', paid_at)";
        case "anio":
        default:
            return "strftime('%m/%Y', paid_at)";
    }
}

function nI(v: any): number {
    const x = Number(v ?? 0);
    return Number.isFinite(x) ? Math.trunc(x) : 0;
}
function nF(v: any): number {
    const x = Number(v ?? 0);
    return Number.isFinite(x) ? x : 0;
}
function s(v: any): string {
    return String(v ?? "").trim();
}

export async function handleStatsMesasGet(
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
        if (!ctx?.claims?.tenantId) {
            return unauthorized(req, "invalid_token_claims");
        }

        const bodyRaw = await readJsonSafe<StatsMesasInput>(req, {});
        const body = unwrapArgs<StatsMesasInput>(bodyRaw);
        const range = normalizeRange(body?.range);

        const { start, end } = rangeBounds(range);
        const bucketExpr = bucketPaidAt(range);

        const totalR = await db.execute({
            sql: `
        SELECT COUNT(*) AS n
        FROM Mesas
        WHERE COALESCE(Es_Sistema,0)=0;
      `,
            args: [],
        });
        const total_mesas = nI((totalR.rows?.[0] as any)?.n);

        const ctes = `
      WITH
      rng AS (SELECT ${start} AS start_dt, ${end} AS end_dt),
      paid_det AS (
        SELECT pd.ID_Detalle AS ID_Detalle, MIN(p.Fecha_Hora) AS paid_at
        FROM Pago_Detalles pd
        JOIN Pagos p ON p.ID_Pago = pd.ID_Pago
        GROUP BY pd.ID_Detalle
      ),
      comanda_paid_at AS (
        SELECT
          c.ID_Comanda AS ID_Comanda,
          c.ID_Mesa    AS ID_Mesa,
          MAX(pd.paid_at) AS paid_at,
          ROUND(SUM(COALESCE(dc.Cantidad,1) * COALESCE(dc.Precio_Unitario,0)), 2) AS total
        FROM Comandas c
        JOIN Detalle_Comanda dc ON dc.ID_Comanda = c.ID_Comanda
        JOIN paid_det pd ON pd.ID_Detalle = dc.ID_Detalle
        GROUP BY c.ID_Comanda
      ),
      pagadas AS (
        SELECT cp.*
        FROM comanda_paid_at cp, rng
        WHERE cp.paid_at >= rng.start_dt
          AND cp.paid_at <  rng.end_dt
          AND NOT EXISTS (
            SELECT 1
            FROM Detalle_Comanda dc2
            WHERE dc2.ID_Comanda = cp.ID_Comanda
              AND NOT EXISTS (
                SELECT 1 FROM paid_det pd2 WHERE pd2.ID_Detalle = dc2.ID_Detalle
              )
          )
      )
    `;

        const occR = await db.execute({
            sql: `
        ${ctes}
        SELECT COUNT(DISTINCT m.ID_Mesa) AS n
        FROM pagadas p
        JOIN Mesas m ON m.ID_Mesa = p.ID_Mesa
        WHERE COALESCE(m.Es_Sistema,0)=0;
      `,
            args: [],
        });
        const ocupadas = nI((occR.rows?.[0] as any)?.n);

        const ingR = await db.execute({
            sql: `
        ${ctes}
        SELECT ROUND(COALESCE(SUM(p.total),0),2) AS total
        FROM pagadas p
        JOIN Mesas m ON m.ID_Mesa = p.ID_Mesa
        WHERE COALESCE(m.Es_Sistema,0)=0;
      `,
            args: [],
        });
        const total_ingresos = nF((ingR.rows?.[0] as any)?.total);

        const ticket_medio_por_mesa =
            ocupadas > 0
                ? Math.round((total_ingresos / ocupadas) * 100) / 100
                : 0;

        const topR = await db.execute({
            sql: `
        ${ctes}
        SELECT
          m.Numero_Mesa AS mesa,
          z.Nombre_Zona AS zona,
          COUNT(*) AS comandas
        FROM pagadas p
        JOIN Mesas m ON m.ID_Mesa = p.ID_Mesa
        JOIN Zonas z ON z.ID_Zona = m.ID_Zona
        WHERE COALESCE(m.Es_Sistema,0)=0
        GROUP BY p.ID_Mesa
        ORDER BY comandas DESC, m.Numero_Mesa ASC
        LIMIT 1;
      `,
            args: [],
        });

        const topRow: any | undefined = (topR.rows ?? [])[0] as any;
        const mesa_top_comandas = topRow
            ? {
                mesa: s(topRow.mesa),
                zona: s(topRow.zona),
                comandas: nI(topRow.comandas),
            }
            : null;

        const servR = await db.execute({
            sql: `
        ${ctes}
        SELECT ${bucketExpr} AS b, COUNT(*) AS n
        FROM pagadas
        GROUP BY b
        ORDER BY b ASC;
      `,
            args: [],
        });

        const servicios = {
            labels: (servR.rows ?? []).map((r: any) => s(r.b)),
            values: (servR.rows ?? []).map((r: any) => nI(r.n)),
        };

        const topMesasR = await db.execute({
            sql: `
        ${ctes}
        SELECT
          m.Numero_Mesa AS mesa,
          z.Nombre_Zona AS zona,
          ROUND(SUM(p.total),2) AS total
        FROM pagadas p
        JOIN Mesas m ON m.ID_Mesa = p.ID_Mesa
        JOIN Zonas z ON z.ID_Zona = m.ID_Zona
        WHERE COALESCE(m.Es_Sistema,0)=0
        GROUP BY p.ID_Mesa
        ORDER BY total DESC
        LIMIT 10;
      `,
            args: [],
        });

        const top_mesas_ingresos = (topMesasR.rows ?? []).map((r: any) => ({
            mesa: s(r.mesa),
            zona: s(r.zona),
            total: nF(r.total),
        }));

        return json(
            {
                total_mesas,
                ocupadas,
                ticket_medio_por_mesa,
                mesa_top_comandas,
                servicios,
                top_mesas_ingresos,
            },
            200,
            req,
        );
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}