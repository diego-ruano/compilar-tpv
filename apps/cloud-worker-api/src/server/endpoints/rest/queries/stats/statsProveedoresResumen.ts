import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, unauthorized, serverError } from "../../../../utils/response";

type StatsRange = "hoy" | "semana" | "mes" | "anio";

type StatsProveedoresResumenInput = {
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

function bucketSqlDatetime(range: StatsRange, dtExpr: string): string {
    switch (range) {
        case "hoy":
            return `strftime('%H', ${dtExpr})`;
        case "semana":
        case "mes":
            return `strftime('%d/%m', ${dtExpr})`;
        case "anio":
        default:
            return `strftime('%m/%Y', ${dtExpr})`;
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

async function tableExists(db: Client, table: string): Promise<boolean> {
    const r = await db.execute({
        sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?1 LIMIT 1;",
        args: [table],
    });
    return (r.rows ?? []).length > 0;
}

async function tableHasColumn(
    db: Client,
    table: string,
    column: string,
): Promise<boolean> {
    const r = await db.execute({
        sql: `PRAGMA table_info(${table});`,
        args: [],
    });
    return (r.rows ?? []).some(
        (row: any) => String(row.name ?? row[1] ?? "") === column,
    );
}

export async function handleStatsProveedoresResumen(
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

        const bodyRaw = await readJsonSafe<StatsProveedoresResumenInput>(req, {});
        const body = unwrapArgs<StatsProveedoresResumenInput>(bodyRaw);
        const range = normalizeRange(body?.range);
        const { start, end } = rangeBounds(range);

        if (!(await tableExists(db, "Cuentas_Gastos"))) {
            return json(
                {
                    total_gasto: 0,
                    num_gastos: 0,
                    gasto_medio: 0,
                    porcentaje_sobre_total_gastos: 0,
                    proveedor_top: null,
                    gastos_evolucion: { labels: [], values: [] },
                    gasto_por_proveedor: { labels: [], values: [] },
                    ultimos_gastos: [],
                },
                200,
                req,
            );
        }

        const hasFecha = await tableHasColumn(
            db,
            "Cuentas_Gastos",
            "Fecha",
        ).catch(() => false);
        const hasImporte = await tableHasColumn(
            db,
            "Cuentas_Gastos",
            "Importe",
        ).catch(() => false);

        if (!hasFecha || !hasImporte) {
            return json(
                {
                    total_gasto: 0,
                    num_gastos: 0,
                    gasto_medio: 0,
                    porcentaje_sobre_total_gastos: 0,
                    proveedor_top: null,
                    gastos_evolucion: { labels: [], values: [] },
                    gasto_por_proveedor: { labels: [], values: [] },
                    ultimos_gastos: [],
                },
                200,
                req,
            );
        }

        const hasIdProv = await tableHasColumn(
            db,
            "Cuentas_Gastos",
            "ID_Proveedor",
        ).catch(() => false);
        const hasTipo = await tableHasColumn(
            db,
            "Cuentas_Gastos",
            "Tipo_Gasto",
        ).catch(() => false);
        const hasConcepto = await tableHasColumn(
            db,
            "Cuentas_Gastos",
            "Concepto",
        ).catch(() => false);
        const hasProveedoresTable = await tableExists(db, "Proveedores").catch(
            () => false,
        );

        const dtExpr =
            "CASE WHEN cg.Fecha LIKE '%:%' THEN datetime(cg.Fecha) ELSE datetime(cg.Fecha || ' 00:00:00') END";
        const bucketExpr = bucketSqlDatetime(range, dtExpr);

        let supplierFilter = "";
        if (hasIdProv && hasTipo) {
            supplierFilter =
                "AND (cg.ID_Proveedor IS NOT NULL OR lower(cg.Tipo_Gasto) LIKE '%proveedor%')";
        } else if (hasIdProv) {
            supplierFilter = "AND (cg.ID_Proveedor IS NOT NULL)";
        } else if (hasTipo) {
            supplierFilter = "AND (lower(cg.Tipo_Gasto) LIKE '%proveedor%')";
        } else {
            return json(
                {
                    total_gasto: 0,
                    num_gastos: 0,
                    gasto_medio: 0,
                    porcentaje_sobre_total_gastos: 0,
                    proveedor_top: null,
                    gastos_evolucion: { labels: [], values: [] },
                    gasto_por_proveedor: { labels: [], values: [] },
                    ultimos_gastos: [],
                },
                200,
                req,
            );
        }

        const totalAllR = await db.execute({
            sql: `
        WITH rng AS (SELECT ${start} AS start_dt, ${end} AS end_dt)
        SELECT ROUND(COALESCE(SUM(COALESCE(cg.Importe,0)),0),2) AS total
        FROM Cuentas_Gastos cg, rng
        WHERE cg.Fecha IS NOT NULL
          AND ${dtExpr} >= rng.start_dt
          AND ${dtExpr} <  rng.end_dt;
      `,
            args: [],
        });
        const total_all = nF((totalAllR.rows?.[0] as any)?.total);

        const totalR = await db.execute({
            sql: `
        WITH rng AS (SELECT ${start} AS start_dt, ${end} AS end_dt)
        SELECT
          ROUND(COALESCE(SUM(COALESCE(cg.Importe,0)),0),2) AS total,
          COUNT(*) AS n
        FROM Cuentas_Gastos cg, rng
        WHERE cg.Fecha IS NOT NULL
          AND ${dtExpr} >= rng.start_dt
          AND ${dtExpr} <  rng.end_dt
          ${supplierFilter};
      `,
            args: [],
        });

        const total_gasto = nF((totalR.rows?.[0] as any)?.total);
        const num_gastos = nI((totalR.rows?.[0] as any)?.n);

        const gasto_medio =
            num_gastos > 0
                ? Math.round((total_gasto / num_gastos) * 100) / 100
                : 0;

        const porcentaje_sobre_total_gastos =
            Math.abs(total_all) > 1e-9
                ? Math.round((total_gasto / total_all) * 100 * 100) / 100
                : 0;

        const joinProv =
            hasIdProv && hasProveedoresTable
                ? "LEFT JOIN Proveedores p ON p.ID_Proveedor = cg.ID_Proveedor"
                : "";

        const nameExpr =
            hasIdProv && hasProveedoresTable
                ? `
          CASE
            WHEN cg.ID_Proveedor IS NOT NULL THEN
              COALESCE(NULLIF(trim(p.Nombre_Empresa),''), ('Proveedor #' || CAST(cg.ID_Proveedor AS TEXT)))
            ELSE 'Sin proveedor'
          END
        `
                : hasIdProv
                    ? `
          CASE
            WHEN cg.ID_Proveedor IS NOT NULL THEN ('Proveedor #' || CAST(cg.ID_Proveedor AS TEXT))
            ELSE 'Sin proveedor'
          END
        `
                    : "'Proveedor'";

        const topR = await db.execute({
            sql: `
        WITH rng AS (SELECT ${start} AS start_dt, ${end} AS end_dt)
        SELECT
          ${nameExpr} AS proveedor,
          ROUND(COALESCE(SUM(COALESCE(cg.Importe,0)),0),2) AS total
        FROM Cuentas_Gastos cg
        ${joinProv}
        , rng
        WHERE cg.Fecha IS NOT NULL
          AND ${dtExpr} >= rng.start_dt
          AND ${dtExpr} <  rng.end_dt
          ${supplierFilter}
        GROUP BY proveedor
        ORDER BY total DESC, proveedor ASC
        LIMIT 1;
      `,
            args: [],
        });

        const topRow: any | undefined = (topR.rows ?? [])[0] as any;
        const proveedor_top = topRow
            ? {
                nombre: s(topRow.proveedor),
                total: Math.round(nF(topRow.total) * 100) / 100,
            }
            : null;

        const evoR = await db.execute({
            sql: `
        WITH rng AS (SELECT ${start} AS start_dt, ${end} AS end_dt)
        SELECT
          ${bucketExpr} AS b,
          ROUND(COALESCE(SUM(COALESCE(cg.Importe,0)),0),2) AS total
        FROM Cuentas_Gastos cg, rng
        WHERE cg.Fecha IS NOT NULL
          AND ${dtExpr} >= rng.start_dt
          AND ${dtExpr} <  rng.end_dt
          ${supplierFilter}
        GROUP BY b
        ORDER BY b ASC;
      `,
            args: [],
        });

        const gastos_evolucion = {
            labels: (evoR.rows ?? []).map((r: any) => s(r.b)),
            values: (evoR.rows ?? []).map(
                (r: any) => Math.round(nF(r.total) * 100) / 100,
            ),
        };

        const barR = await db.execute({
            sql: `
        WITH rng AS (SELECT ${start} AS start_dt, ${end} AS end_dt)
        SELECT
          ${nameExpr} AS proveedor,
          ROUND(COALESCE(SUM(COALESCE(cg.Importe,0)),0),2) AS total
        FROM Cuentas_Gastos cg
        ${joinProv}
        , rng
        WHERE cg.Fecha IS NOT NULL
          AND ${dtExpr} >= rng.start_dt
          AND ${dtExpr} <  rng.end_dt
          ${supplierFilter}
        GROUP BY proveedor
        ORDER BY total DESC, proveedor ASC
        LIMIT 12;
      `,
            args: [],
        });

        const gasto_por_proveedor = {
            labels: (barR.rows ?? []).map((r: any) => s(r.proveedor)),
            values: (barR.rows ?? []).map(
                (r: any) => Math.round(nF(r.total) * 100) / 100,
            ),
        };

        const conceptoExpr = hasConcepto ? "COALESCE(cg.Concepto,'')" : "''";

        const lastR = await db.execute({
            sql: `
        WITH rng AS (SELECT ${start} AS start_dt, ${end} AS end_dt)
        SELECT
          strftime('%Y-%m-%d', ${dtExpr}) AS fecha,
          ${nameExpr} AS proveedor,
          ${conceptoExpr} AS concepto,
          ROUND(COALESCE(cg.Importe,0),2) AS importe
        FROM Cuentas_Gastos cg
        ${joinProv}
        , rng
        WHERE cg.Fecha IS NOT NULL
          AND ${dtExpr} >= rng.start_dt
          AND ${dtExpr} <  rng.end_dt
          ${supplierFilter}
        ORDER BY datetime(${dtExpr}) DESC
        LIMIT 10;
      `,
            args: [],
        });

        const ultimos_gastos = (lastR.rows ?? []).map((r: any) => ({
            fecha: s(r.fecha),
            proveedor: s(r.proveedor || "—"),
            concepto: s(r.concepto),
            importe: Math.round(nF(r.importe) * 100) / 100,
        }));

        return json(
            {
                total_gasto: Math.round(total_gasto * 100) / 100,
                num_gastos,
                gasto_medio,
                porcentaje_sobre_total_gastos,
                proveedor_top,
                gastos_evolucion,
                gasto_por_proveedor,
                ultimos_gastos,
            },
            200,
            req,
        );
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}