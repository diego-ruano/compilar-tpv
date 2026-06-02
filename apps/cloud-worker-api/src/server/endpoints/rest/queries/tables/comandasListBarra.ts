// src/server/endpoints/rest/queries/tables/comandasListBarra.ts
import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, unauthorized, serverError } from "../../../../utils/response";
import { getTenantIdFromContext } from "../../../../utils/tenantHubWrites";

type ListBarraInput = {
    include_pagadas?: boolean;
    includePagadas?: boolean;
    limit?: number;
};

async function readJsonSafe<T>(req: Request, fallback: T): Promise<T> {
    try {
        return (await req.json()) as T;
    } catch {
        return fallback;
    }
}

function parseBool(v: any, fallback = false): boolean {
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;

    const s = String(v ?? "").trim().toLowerCase();
    if (!s) return fallback;

    if (["1", "true", "yes", "y", "si", "sí"].includes(s)) return true;
    if (["0", "false", "no", "n"].includes(s)) return false;

    return fallback;
}

function parseLimit(v: any): number {
    const n = Number(v ?? 50);
    if (!Number.isFinite(n)) return 50;
    return Math.max(1, Math.min(200, Math.trunc(n)));
}

async function firstMesaBarraId(db: Client): Promise<number | null> {
    const candidates = [
        `
			SELECT ID_Mesa
			FROM Mesas
			WHERE UPPER(TRIM(CAST(Nombre_Mesa AS TEXT))) = 'BARRA'
			LIMIT 1;
		`,
        `
			SELECT ID_Mesa
			FROM Mesas
			WHERE UPPER(TRIM(CAST(Nombre AS TEXT))) = 'BARRA'
			LIMIT 1;
		`,
        `
			SELECT ID_Mesa
			FROM Mesas
			WHERE UPPER(TRIM(CAST(Numero_Mesa AS TEXT))) = 'BARRA'
			LIMIT 1;
		`,
        `
			SELECT ID_Mesa
			FROM Mesas
			WHERE COALESCE(Es_Barra, 0) = 1
			LIMIT 1;
		`,
    ];

    for (const sql of candidates) {
        try {
            const r = await db.execute({ sql, args: [] });
            const row = r.rows?.[0] as any | undefined;
            const id = Number(row?.ID_Mesa ?? row?.[0] ?? 0);

            if (Number.isFinite(id) && id > 0) {
                return id;
            }
        } catch {
            // Compatibilidad con tenants que todavía no tengan alguna columna.
        }
    }

    return null;
}

export async function handleComandasListBarra(
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
        const tenantId = getTenantIdFromContext(ctx);

        if (!tenantId) {
            return unauthorized(req, "invalid_token_claims");
        }

        const url = new URL(req.url);
        const body =
            req.method === "GET"
                ? ({} as ListBarraInput)
                : await readJsonSafe<ListBarraInput>(req, {});

        const includePagadas = parseBool(
            body?.include_pagadas ??
            body?.includePagadas ??
            url.searchParams.get("include_pagadas") ??
            url.searchParams.get("includePagadas"),
            false,
        );

        const limit = parseLimit(body?.limit ?? url.searchParams.get("limit"));

        const idMesaBarra = await firstMesaBarraId(db);

        if (!idMesaBarra) {
            return json([], 200, req);
        }

        const sql = `
			SELECT
			  c.ID_Comanda,
			  c.Fecha_Hora_Apertura,
			  c.Estado,

			  (
				SELECT IFNULL(SUM(dc.Precio_Unitario * COALESCE(dc.Cantidad,1)), 0)
				FROM Detalle_Comanda dc
				LEFT JOIN Pago_Detalles pd ON pd.ID_Detalle = dc.ID_Detalle
				WHERE dc.ID_Comanda = c.ID_Comanda
				  AND pd.ID_Detalle IS NULL
			  ) AS Total_Pendiente,

			  (
				SELECT IFNULL(SUM(dc.Precio_Unitario * COALESCE(dc.Cantidad,1)), 0)
				FROM Detalle_Comanda dc
				WHERE dc.ID_Comanda = c.ID_Comanda
			  ) AS Total_Comanda,

			  (
				SELECT COUNT(*)
				FROM Detalle_Comanda dc
				JOIN Productos p ON p.ID_Producto = dc.ID_Producto
				JOIN Categorias_Producto cat ON cat.ID_Categoria = p.ID_Categoria
				LEFT JOIN Pago_Detalles pd ON pd.ID_Detalle = dc.ID_Detalle
				WHERE dc.ID_Comanda = c.ID_Comanda
				  AND pd.ID_Detalle IS NULL
				  AND COALESCE(cat.Pasa_Cocina, 0) = 1
				  AND COALESCE(dc.Estado_Cocina,'PENDIENTE') <> 'PREPARADO'
			  ) AS Pendientes_Cocina,

			  (
				SELECT COUNT(*)
				FROM Detalle_Comanda dc
				LEFT JOIN Pago_Detalles pd ON pd.ID_Detalle = dc.ID_Detalle
				WHERE dc.ID_Comanda = c.ID_Comanda
				  AND pd.ID_Detalle IS NULL
			  ) AS Pendientes_Pago

			FROM Comandas c
			WHERE c.ID_Mesa = ?1
			  ${includePagadas ? "" : "AND c.Estado = 'Abierta'"}
			  AND EXISTS (
				SELECT 1
				FROM Detalle_Comanda dc
				WHERE dc.ID_Comanda = c.ID_Comanda
			  )
			ORDER BY datetime(c.Fecha_Hora_Apertura) DESC, c.ID_Comanda DESC
			LIMIT ?2;
		`;

        const r = await db.execute({
            sql,
            args: [idMesaBarra, limit],
        });

        const out = (r.rows ?? []).map((row: any) => ({
            id_comanda: Number(row.ID_Comanda ?? row[0] ?? 0),
            fecha_hora_apertura: String(row.Fecha_Hora_Apertura ?? row[1] ?? ""),
            estado: String(row.Estado ?? row[2] ?? ""),
            total_pendiente: Number(row.Total_Pendiente ?? row[3] ?? 0),
            total_comanda: Number(row.Total_Comanda ?? row[4] ?? 0),
            pendientes_cocina: Number(row.Pendientes_Cocina ?? row[5] ?? 0),
            pendientes_pago: Number(row.Pendientes_Pago ?? row[6] ?? 0),
        }));

        return json(out, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", {
            message: String(e?.message || e),
            name: e?.name,
            stack: e?.stack,
        });
    }
}