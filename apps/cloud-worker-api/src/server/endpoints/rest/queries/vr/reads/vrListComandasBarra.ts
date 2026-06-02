import type { Client } from "@libsql/client/web";
import { buildTenantContext } from "../../../../../middleware/withTenant";
import { createDbClient } from "../../../../../db/clients";
import { json, serverError } from "../../../../../utils/response";

export type ComandaBarraRow = {
    ID_Comanda: number;
    Fecha_Hora_Apertura: string;
    Estado: string;
    Total_Pendiente: number;
    Total_Comanda: number;
    Pendientes_Cocina: number;
    Pendientes_Pago: number;
};

async function readJsonSafe<T>(req: Request, fallback: T): Promise<T> {
    try {
        return (await req.json()) as T;
    } catch {
        return fallback;
    }
}

function pickTenantDb(ctx: any): Client {
    const db =
        (ctx?.dbTenant as Client) ||
        (ctx?.db as Client) ||
        (ctx?.tenantDb as Client) ||
        (ctx?.client as Client);
    if (!db) throw new Error("tenant_db_missing");
    return db;
}

function unwrapArgs<T = any>(body: any): T {
    if (body && typeof body === "object" && body.args && typeof body.args === "object") {
        return body.args as T;
    }
    return (body ?? {}) as T;
}

export async function handleVrListComandasBarra(
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

        const body = await readJsonSafe<any>(req, {});
        const args = unwrapArgs<any>(body);

        const includePagadas = Boolean(args.includePagadas ?? args.include_pagadas ?? false);

        const mesaBarra = await db.execute({
            sql: `
                SELECT ID_Mesa
                FROM Mesas
                WHERE Numero_Mesa = 'BARRA'
                LIMIT 1;
            `,
            args: [],
        });

        const mesaBarraRow = mesaBarra.rows?.[0] as any | undefined;
        const idMesaBarra = Number(
            mesaBarraRow?.ID_Mesa ??
            mesaBarraRow?.id_mesa ??
            Object.values(mesaBarraRow ?? {})[0] ??
            0,
        );

        if (!(Number.isFinite(idMesaBarra) && idMesaBarra > 0)) {
            return json({ ok: true, result: [], data: [] }, 200, req);
        }

        const limRaw = Number(args.limit ?? 60);
        const lim = limRaw > 0 ? Math.floor(limRaw) : 60;

        const pendingExpr = `
            CASE
              WHEN (
                COALESCE(c.Total_Comanda,0)
                - COALESCE((
                    SELECT SUM(p.Importe_Total)
                    FROM Pagos p
                    WHERE p.ID_Comanda = c.ID_Comanda
                  ), 0)
              ) < 0
              THEN 0
              ELSE (
                COALESCE(c.Total_Comanda,0)
                - COALESCE((
                    SELECT SUM(p.Importe_Total)
                    FROM Pagos p
                    WHERE p.ID_Comanda = c.ID_Comanda
                  ), 0)
              )
            END
        `;

        const whereClause = includePagadas
            ? `
                EXISTS (
                  SELECT 1
                  FROM Detalle_Comanda dc
                  WHERE dc.ID_Comanda = c.ID_Comanda
                )
              `
            : `
                (${pendingExpr}) > 0
                AND EXISTS (
                  SELECT 1
                  FROM Detalle_Comanda dc
                  WHERE dc.ID_Comanda = c.ID_Comanda
                )
              `;

        const sql = `
            SELECT
              c.ID_Comanda,
              c.Fecha_Hora_Apertura,
              c.Estado,

              ROUND(${pendingExpr}, 2) AS Total_Pendiente,
              ROUND(COALESCE(c.Total_Comanda,0), 2) AS Total_Comanda,

              COALESCE((
                SELECT COUNT(*)
                FROM Detalle_Comanda dc
                LEFT JOIN Productos pr ON pr.ID_Producto = dc.ID_Producto
                LEFT JOIN Categorias_Producto cat ON cat.ID_Categoria = pr.ID_Categoria
                WHERE dc.ID_Comanda = c.ID_Comanda
                  AND COALESCE(cat.Pasa_Cocina,0)=1
                  AND COALESCE(dc.Estado_Cocina,'PENDIENTE') <> 'PREPARADO'
              ),0) AS Pendientes_Cocina,

              COALESCE((
                SELECT COUNT(*)
                FROM Detalle_Comanda dc
                WHERE dc.ID_Comanda = c.ID_Comanda
                  AND NOT EXISTS (
                    SELECT 1
                    FROM Pago_Detalles pd
                    WHERE pd.ID_Detalle = dc.ID_Detalle
                  )
              ),0) AS Pendientes_Pago

            FROM Comandas c
            WHERE c.ID_Mesa = ?2
              AND (${whereClause})
            ORDER BY c.ID_Comanda DESC
            LIMIT ?1;
        `;

        const r = await db.execute({ sql, args: [lim, idMesaBarra] });

        const out: ComandaBarraRow[] = (r.rows || []).map((row: any) => ({
            ID_Comanda: Number(row.ID_Comanda || 0),
            Fecha_Hora_Apertura: String(row.Fecha_Hora_Apertura || ""),
            Estado: String(row.Estado || "Abierta"),
            Total_Pendiente: Number(row.Total_Pendiente || 0),
            Total_Comanda: Number(row.Total_Comanda || 0),
            Pendientes_Cocina: Number(row.Pendientes_Cocina || 0),
            Pendientes_Pago: Number(row.Pendientes_Pago || 0),
        }));

        return json({ ok: true, result: out }, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", {
            message: String(e?.message || e),
        });
    }
}