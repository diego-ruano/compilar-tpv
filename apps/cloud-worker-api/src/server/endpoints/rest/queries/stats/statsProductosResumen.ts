import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, unauthorized, serverError } from "../../../../utils/response";

type StatsRange = "hoy" | "semana" | "mes" | "anio";

type StatsProductosResumenInput = {
    range?: StatsRange;
    categoriaTopId?: number | null;
    categoriaWorstId?: number | null;
    categoria_top_id?: number | null;
    categoria_worst_id?: number | null;
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

function nI(v: any): number {
    const x = Number(v ?? 0);
    return Number.isFinite(x) ? Math.trunc(x) : 0;
}
function s(v: any): string {
    return String(v ?? "").trim();
}

export async function handleStatsProductosResumen(
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

        const bodyRaw = await readJsonSafe<StatsProductosResumenInput>(req, {});
        const body = unwrapArgs<StatsProductosResumenInput>(bodyRaw);

        const range = normalizeRange(body?.range);
        const categoriaTopId =
            Number(body?.categoriaTopId ?? body?.categoria_top_id ?? 0) || 0;
        const categoriaWorstId =
            Number(body?.categoriaWorstId ?? body?.categoria_worst_id ?? 0) || 0;

        const { start, end } = rangeBounds(range);

        const ctes = `
      WITH
      rng AS (SELECT ${start} AS start_dt, ${end} AS end_dt),
      paid_det AS (
        SELECT pd.ID_Detalle AS ID_Detalle, MIN(p.Fecha_Hora) AS paid_at
        FROM Pago_Detalles pd
        JOIN Pagos p ON p.ID_Pago = pd.ID_Pago
        GROUP BY pd.ID_Detalle
      )
    `;

        const bestR = await db.execute({
            sql: `
        ${ctes}
        SELECT
          pr.Nombre AS nombre,
          CAST(ROUND(SUM(COALESCE(dc.Cantidad,1)),0) AS INTEGER) AS unidades
        FROM Detalle_Comanda dc
        JOIN paid_det pd ON pd.ID_Detalle = dc.ID_Detalle
        JOIN rng ON 1=1
        JOIN Productos pr ON pr.ID_Producto = dc.ID_Producto
        JOIN Categorias_Producto cat ON cat.ID_Categoria = pr.ID_Categoria
        WHERE pd.paid_at >= rng.start_dt
          AND pd.paid_at <  rng.end_dt
          AND COALESCE(cat.Vendible,1)=1
        GROUP BY pr.ID_Producto
        HAVING SUM(COALESCE(dc.Cantidad,1)) > 0
        ORDER BY unidades DESC, pr.Nombre ASC
        LIMIT 1;
      `,
            args: [],
        });
        const mejor_producto = (bestR.rows?.[0] as any)?.nombre
            ? s((bestR.rows?.[0] as any)?.nombre)
            : null;

        const worstOneR = await db.execute({
            sql: `
        ${ctes}
        SELECT
          pr.Nombre AS nombre,
          CAST(ROUND(COALESCE(SUM(
            CASE WHEN pd.paid_at >= rng.start_dt AND pd.paid_at < rng.end_dt
                 THEN COALESCE(dc.Cantidad,1)
                 ELSE 0
            END
          ),0),0) AS INTEGER) AS unidades
        FROM Productos pr
        JOIN Categorias_Producto cat ON cat.ID_Categoria = pr.ID_Categoria
        LEFT JOIN Detalle_Comanda dc ON dc.ID_Producto = pr.ID_Producto
        LEFT JOIN paid_det pd ON pd.ID_Detalle = dc.ID_Detalle
        JOIN rng ON 1=1
        WHERE COALESCE(cat.Vendible,1)=1
        GROUP BY pr.ID_Producto
        ORDER BY unidades ASC, pr.Nombre ASC
        LIMIT 1;
      `,
            args: [],
        });
        const peor_producto_vendible = (worstOneR.rows?.[0] as any)?.nombre
            ? s((worstOneR.rows?.[0] as any)?.nombre)
            : null;

        const topFilter = categoriaTopId > 0 ? "AND pr.ID_Categoria = ?1" : "";
        const topArgs = categoriaTopId > 0 ? [categoriaTopId] : [];
        const topR = await db.execute({
            sql: `
        ${ctes}
        SELECT
          pr.Nombre AS nombre,
          CAST(ROUND(SUM(COALESCE(dc.Cantidad,1)),0) AS INTEGER) AS unidades
        FROM Detalle_Comanda dc
        JOIN paid_det pd ON pd.ID_Detalle = dc.ID_Detalle
        JOIN rng ON 1=1
        JOIN Productos pr ON pr.ID_Producto = dc.ID_Producto
        JOIN Categorias_Producto cat ON cat.ID_Categoria = pr.ID_Categoria
        WHERE pd.paid_at >= rng.start_dt
          AND pd.paid_at <  rng.end_dt
          AND COALESCE(cat.Vendible,1)=1
          ${topFilter}
        GROUP BY pr.ID_Producto
        HAVING SUM(COALESCE(dc.Cantidad,1)) > 0
        ORDER BY unidades DESC, pr.Nombre ASC
        LIMIT 10;
      `,
            args: topArgs,
        });

        const top10_mejores = {
            labels: (topR.rows ?? []).map((r: any) => s(r.nombre)),
            values: (topR.rows ?? []).map((r: any) => nI(r.unidades)),
        };

        const worstFilter =
            categoriaWorstId > 0 ? "AND pr.ID_Categoria = ?1" : "";
        const worstArgs = categoriaWorstId > 0 ? [categoriaWorstId] : [];
        const worstR = await db.execute({
            sql: `
        ${ctes}
        SELECT
          pr.Nombre AS nombre,
          CAST(ROUND(COALESCE(SUM(
            CASE WHEN pd.paid_at >= rng.start_dt AND pd.paid_at < rng.end_dt
                 THEN COALESCE(dc.Cantidad,1)
                 ELSE 0
            END
          ),0),0) AS INTEGER) AS unidades
        FROM Productos pr
        JOIN Categorias_Producto cat ON cat.ID_Categoria = pr.ID_Categoria
        LEFT JOIN Detalle_Comanda dc ON dc.ID_Producto = pr.ID_Producto
        LEFT JOIN paid_det pd ON pd.ID_Detalle = dc.ID_Detalle
        JOIN rng ON 1=1
        WHERE COALESCE(cat.Vendible,1)=1
          ${worstFilter}
        GROUP BY pr.ID_Producto
        ORDER BY unidades ASC, pr.Nombre ASC
        LIMIT 10;
      `,
            args: worstArgs,
        });

        const top10_peores = {
            labels: (worstR.rows ?? []).map((r: any) => s(r.nombre)),
            values: (worstR.rows ?? []).map((r: any) => nI(r.unidades)),
        };

        return json(
            {
                mejor_producto,
                peor_producto_vendible,
                top10_mejores,
                top10_peores,
            },
            200,
            req,
        );
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}