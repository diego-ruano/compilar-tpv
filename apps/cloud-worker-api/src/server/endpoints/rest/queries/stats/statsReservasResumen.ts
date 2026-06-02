import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, unauthorized, serverError } from "../../../../utils/response";

type StatsRange = "hoy" | "semana" | "mes" | "anio";
type StatsTurno = "COMIDA" | "CENA" | "TODOS";

type StatsReservasResumenInput = {
    range?: StatsRange;
    turno?: StatsTurno;
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

function normalizeTurno(v: unknown): StatsTurno {
    return v === "COMIDA" || v === "CENA" || v === "TODOS" ? v : "TODOS";
}

function rangeBoundsReservas(range: StatsRange): {
    start: string;
    end: string;
} {
    switch (range) {
        case "hoy":
            return {
                start: "datetime('now','localtime','start of day')",
                end: "datetime('now','localtime','start of day','+1 day')",
            };
        case "semana":
            return {
                start: "datetime('now','localtime','-6 days','start of day')",
                end: "datetime('now','localtime','start of day','+1 day')",
            };
        case "mes":
            return {
                start: "datetime('now','localtime','start of month')",
                end: "datetime('now','localtime','start of day','+1 day')",
            };
        case "anio":
        default:
            return {
                start: "datetime('now','localtime','start of year')",
                end: "datetime('now','localtime','start of day','+1 day')",
            };
    }
}

function bucketResAt(range: StatsRange): string {
    switch (range) {
        case "hoy":
            return "strftime('%H', res_at)";
        case "semana":
        case "mes":
            return "strftime('%d/%m', res_at)";
        case "anio":
        default:
            return "strftime('%m/%Y', res_at)";
    }
}

function nI(v: any): number {
    const x = Number(v ?? 0);
    return Number.isFinite(x) ? Math.trunc(x) : 0;
}
function s(v: any): string {
    return String(v ?? "").trim();
}

export async function handleStatsReservasResumen(
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

        const bodyRaw = await readJsonSafe<StatsReservasResumenInput>(req, {});
        const body = unwrapArgs<StatsReservasResumenInput>(bodyRaw);

        const range = normalizeRange(body?.range);
        const turno = normalizeTurno(body?.turno);

        const { start, end } = rangeBoundsReservas(range);
        const bucketExpr = bucketResAt(range);

        const totalMesasR = await db.execute({
            sql: `
        SELECT COUNT(*) AS n
        FROM Mesas
        WHERE COALESCE(Es_Sistema,0)=0;
      `,
            args: [],
        });
        const total_mesas = nI((totalMesasR.rows?.[0] as any)?.n);

        const ctes = `
      WITH
      rng AS (SELECT ${start} AS start_dt, ${end} AS end_dt),
      res AS (
        SELECT
          r.ID_Reserva,
          r.ID_Mesa,
          r.Turno,
          r.Estado,
          datetime(r.Dia_YMD || ' ' || r.Hora) AS res_at
        FROM Reservas r
        JOIN Mesas m ON m.ID_Mesa = r.ID_Mesa
        WHERE COALESCE(m.Es_Sistema,0)=0
      ),
      res_rng AS (
        SELECT res.*
        FROM res, rng
        WHERE res.res_at >= rng.start_dt
          AND res.res_at <  rng.end_dt
      )
    `;

        const totR = await db.execute({
            sql: `
        ${ctes}
        SELECT COUNT(*) AS n FROM res_rng;
      `,
            args: [],
        });
        const total_reservas = nI((totR.rows?.[0] as any)?.n);

        const canR = await db.execute({
            sql: `
        ${ctes}
        SELECT COUNT(*) AS n
        FROM res_rng
        WHERE COALESCE(Estado,'')='CANCELADA';
      `,
            args: [],
        });
        const cancelaciones = nI((canR.rows?.[0] as any)?.n);

        const turnoFilter =
            turno === "COMIDA"
                ? "AND Turno='COMIDA'"
                : turno === "CENA"
                    ? "AND Turno='CENA'"
                    : "";

        const mesasResR = await db.execute({
            sql: `
        ${ctes}
        SELECT COUNT(DISTINCT ID_Mesa) AS n
        FROM res_rng
        WHERE COALESCE(Estado,'') <> 'CANCELADA'
        ${turnoFilter};
      `,
            args: [],
        });

        const mesas_reservadas = nI((mesasResR.rows?.[0] as any)?.n);
        const mesas_no_reservadas = Math.max(0, total_mesas - mesas_reservadas);

        const barR = await db.execute({
            sql: `
        ${ctes}
        SELECT ${bucketExpr} AS b, COUNT(*) AS n
        FROM res_rng
        GROUP BY b
        ORDER BY b ASC;
      `,
            args: [],
        });
        const reservas_por_bucket = {
            labels: (barR.rows ?? []).map((r: any) => s(r.b)),
            values: (barR.rows ?? []).map((r: any) => nI(r.n)),
        };

        const estR = await db.execute({
            sql: `
        ${ctes}
        SELECT
          SUM(CASE WHEN COALESCE(Estado,'')='ACTIVA' THEN 1 ELSE 0 END) AS activas,
          SUM(CASE WHEN COALESCE(Estado,'')='FINALIZADA' THEN 1 ELSE 0 END) AS finalizadas,
          SUM(CASE WHEN COALESCE(Estado,'')='CANCELADA' THEN 1 ELSE 0 END) AS canceladas
        FROM res_rng;
      `,
            args: [],
        });
        const estRow: any = (estR.rows?.[0] as any) ?? {};
        const estado = {
            labels: ["Activas", "Finalizadas", "Canceladas"],
            values: [
                nI(estRow.activas),
                nI(estRow.finalizadas),
                nI(estRow.canceladas),
            ],
        };

        const frR = await db.execute({
            sql: `
        ${ctes}
        SELECT
          SUM(CASE WHEN CAST(strftime('%H', res_at) AS INTEGER) BETWEEN 0  AND 11 THEN 1 ELSE 0 END) AS f_00_11,
          SUM(CASE WHEN CAST(strftime('%H', res_at) AS INTEGER) BETWEEN 12 AND 15 THEN 1 ELSE 0 END) AS f_12_15,
          SUM(CASE WHEN CAST(strftime('%H', res_at) AS INTEGER) BETWEEN 16 AND 19 THEN 1 ELSE 0 END) AS f_16_19,
          SUM(CASE WHEN CAST(strftime('%H', res_at) AS INTEGER) BETWEEN 20 AND 23 THEN 1 ELSE 0 END) AS f_20_23
        FROM res_rng;
      `,
            args: [],
        });

        const fr: any = (frR.rows?.[0] as any) ?? {};
        const franjas = {
            labels: ["00-11", "12-15", "16-19", "20-23"],
            values: [
                nI(fr.f_00_11),
                nI(fr.f_12_15),
                nI(fr.f_16_19),
                nI(fr.f_20_23),
            ],
        };

        return json(
            {
                total_reservas,
                cancelaciones,
                mesas_turno: { turno, mesas_reservadas, mesas_no_reservadas },
                reservas_por_bucket,
                estado,
                franjas,
            },
            200,
            req,
        );
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}