import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, unauthorized, serverError } from "../../../../utils/response";

type StatsRange = "hoy" | "semana" | "mes" | "anio";

type StatsClientesInput = {
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

export async function handleStatsClientesResumen(
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

        const bodyRaw = await readJsonSafe<StatsClientesInput>(req, {});
        const body = unwrapArgs<StatsClientesInput>(bodyRaw);
        const range = normalizeRange(body?.range);
        const { start, end } = rangeBounds(range);

        if (!(await tableExists(db, "Clientes"))) {
            return json(
                {
                    nuevos: 0,
                    recurrentes: 0,
                    no_recurrentes: 0,
                    ticket_medio_cliente: 0,
                    nuevos_por_bucket: { labels: [], values: [] },
                    top_clientes_gasto: { labels: [], values: [] },
                },
                200,
                req,
            );
        }

        const hasCreated = await tableHasColumn(
            db,
            "Clientes",
            "Created_At",
        ).catch(() => false);
        const hasTotalGastado = await tableHasColumn(
            db,
            "Clientes",
            "Total_Gastado",
        ).catch(() => false);
        const hasNombre = await tableHasColumn(db, "Clientes", "Nombre").catch(
            () => false,
        );
        const hasIdCliente = await tableHasColumn(
            db,
            "Clientes",
            "ID_Cliente",
        ).catch(() => false);

        let nuevos = 0;
        let evoLabels: string[] = [];
        let evoValues: number[] = [];

        if (hasCreated) {
            const altaDt = "datetime(cl.Created_At)";
            const bucketExpr = bucketSqlDatetime(range, altaDt);

            const nuevosR = await db.execute({
                sql: `
          WITH rng AS (SELECT ${start} AS start_dt, ${end} AS end_dt)
          SELECT COUNT(*) AS n
          FROM Clientes cl, rng
          WHERE cl.Created_At IS NOT NULL
            AND ${altaDt} >= rng.start_dt
            AND ${altaDt} <  rng.end_dt;
        `,
                args: [],
            });
            nuevos = nI((nuevosR.rows?.[0] as any)?.n);

            const evoR = await db.execute({
                sql: `
          WITH rng AS (SELECT ${start} AS start_dt, ${end} AS end_dt)
          SELECT ${bucketExpr} AS b, COUNT(*) AS n
          FROM Clientes cl, rng
          WHERE cl.Created_At IS NOT NULL
            AND ${altaDt} >= rng.start_dt
            AND ${altaDt} <  rng.end_dt
          GROUP BY b
          ORDER BY b ASC;
        `,
                args: [],
            });

            evoLabels = (evoR.rows ?? []).map((r: any) => s(r.b));
            evoValues = (evoR.rows ?? []).map((r: any) => nI(r.n));
        }

        let recurrentes = 0;
        let no_recurrentes = 0;
        let ticket_medio_cliente = 0;

        const canSales =
            (await tableExists(db, "Pagos")) &&
            (await tableExists(db, "Comandas")) &&
            (await tableExists(db, "Reservas")) &&
            (await tableHasColumn(db, "Pagos", "ID_Comanda")) &&
            (await tableHasColumn(db, "Pagos", "Fecha_Hora")) &&
            (await tableHasColumn(db, "Pagos", "Importe_Total")) &&
            (await tableHasColumn(db, "Comandas", "ID_Reserva")) &&
            (await tableHasColumn(db, "Reservas", "ID_Reserva")) &&
            (await tableHasColumn(db, "Reservas", "ID_Cliente"));

        if (canSales) {
            const recR = await db.execute({
                sql: `
          WITH
          rng AS (SELECT ${start} AS start_dt, ${end} AS end_dt),
          allp AS (
            SELECT
              r.ID_Cliente AS id_cliente,
              datetime(p.Fecha_Hora) AS paid_at,
              COALESCE(p.Importe_Total,0) AS imp
            FROM Pagos p
            JOIN Comandas c ON c.ID_Comanda = p.ID_Comanda
            JOIN Reservas r ON r.ID_Reserva = c.ID_Reserva
            WHERE c.ID_Reserva IS NOT NULL
              AND r.ID_Cliente IS NOT NULL
              AND p.Fecha_Hora IS NOT NULL
          ),
          cust_range AS (
            SELECT DISTINCT id_cliente
            FROM allp, rng
            WHERE paid_at >= rng.start_dt
              AND paid_at <  rng.end_dt
          ),
          firsts AS (
            SELECT id_cliente, MIN(paid_at) AS first_paid
            FROM allp
            GROUP BY id_cliente
          ),
          tot_range AS (
            SELECT id_cliente, SUM(imp) AS total
            FROM allp, rng
            WHERE paid_at >= rng.start_dt
              AND paid_at <  rng.end_dt
            GROUP BY id_cliente
          )
          SELECT
            (SELECT COUNT(*)
             FROM cust_range cr
             JOIN firsts f ON f.id_cliente = cr.id_cliente, rng
             WHERE f.first_paid < rng.start_dt
            ) AS recurrentes,
            (SELECT COUNT(*)
             FROM cust_range cr
             JOIN firsts f ON f.id_cliente = cr.id_cliente, rng
             WHERE f.first_paid >= rng.start_dt
               AND f.first_paid <  rng.end_dt
            ) AS no_recurrentes,
            ROUND(COALESCE((SELECT SUM(total) FROM tot_range),0),2) AS ventas_total,
            (SELECT COUNT(*) FROM cust_range) AS clientes_rango
          ;
        `,
                args: [],
            });

            const row: any = (recR.rows?.[0] as any) ?? {};
            recurrentes = nI(row.recurrentes);
            no_recurrentes = nI(row.no_recurrentes);

            const ventas_total = nF(row.ventas_total);
            const clientes_rango = nI(row.clientes_rango);

            ticket_medio_cliente =
                clientes_rango > 0
                    ? Math.round((ventas_total / clientes_rango) * 100) / 100
                    : 0;
        }

        let topLabels: string[] = [];
        let topValues: number[] = [];

        if (hasTotalGastado && hasIdCliente) {
            const nameExpr = hasNombre
                ? "CASE WHEN COALESCE(trim(Nombre),'') <> '' THEN trim(Nombre) ELSE 'Cliente' END"
                : "'Cliente'";

            const topR = await db.execute({
                sql: `
          SELECT
            (${nameExpr} || ' #' || CAST(ID_Cliente AS TEXT)) AS nombre,
            ROUND(COALESCE(Total_Gastado,0),2) AS total
          FROM Clientes
          ORDER BY COALESCE(Total_Gastado,0) DESC, nombre ASC
          LIMIT 10;
        `,
                args: [],
            });

            topLabels = (topR.rows ?? []).map((r: any) => s(r.nombre));
            topValues = (topR.rows ?? []).map(
                (r: any) => Math.round(nF(r.total) * 100) / 100,
            );
        }

        return json(
            {
                nuevos,
                recurrentes,
                no_recurrentes,
                ticket_medio_cliente,
                nuevos_por_bucket: { labels: evoLabels, values: evoValues },
                top_clientes_gasto: { labels: topLabels, values: topValues },
            },
            200,
            req,
        );
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}