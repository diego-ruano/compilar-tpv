// src/server/endpoints/rest/queries/ventaRapida/vrGetLineasComanda.ts
import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../../middleware/withTenant";
import { createDbClient } from "../../../../../db/clients";
import { json, serverError, unauthorized } from "../../../../../utils/response";

export type LineaComandaRow = {
    ID_Detalle: number;
    ID_Comanda: number;
    ID_Producto: number;
    Cantidad: number;
    Precio_Unitario: number;
    Notas: string | null;
    Estado_Cocina: string | null;
    Pagado: number;
    Nombre: string;
};

type VrGetLineasComandaInput = {
    id_comanda: number;
};

async function readJsonSafe<T>(req: Request, fallback: T): Promise<T> {
    try {
        return (await req.json()) as T;
    } catch {
        return fallback;
    }
}

export async function handleVrGetLineasComanda(
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

        const tenantId = String(ctx?.claims?.tenantId || "").trim();
        if (!tenantId) {
            return unauthorized(req, "invalid_token_claims");
        }

        const db: Client | undefined = ctx?.dbTenant;
        if (!db) {
            throw new Error("tenant_db_missing");
        }

        const body = await readJsonSafe<VrGetLineasComandaInput>(req, {
            id_comanda: 0,
        });

        const idComanda = Number(body.id_comanda || 0);

        if (!(idComanda > 0)) {
            return json({ ok: true, result: [] }, 200, req);
        }

        const r = await db.execute({
            sql: `
                SELECT
                    dc.ID_Detalle,
                    dc.ID_Comanda,
                    dc.ID_Producto,
                    COALESCE(dc.Cantidad, 1) AS Cantidad,
                    COALESCE(dc.Precio_Unitario, 0) AS Precio_Unitario,
                    dc.Notas,
                    dc.Estado_Cocina,
                    CASE
                        WHEN EXISTS (
                            SELECT 1
                            FROM Pago_Detalles pd
                            WHERE pd.ID_Detalle = dc.ID_Detalle
                        )
                        THEN 1
                        ELSE 0
                    END AS Pagado,
                    COALESCE(p.Nombre, 'Producto') AS Nombre
                FROM Detalle_Comanda dc
                LEFT JOIN Productos p ON p.ID_Producto = dc.ID_Producto
                WHERE dc.ID_Comanda = ?1
                ORDER BY dc.ID_Detalle ASC;
            `,
            args: [idComanda],
        });

        const out: LineaComandaRow[] = (r.rows || []).map((row: any) => ({
            ID_Detalle: Number(row.ID_Detalle || 0),
            ID_Comanda: Number(row.ID_Comanda || 0),
            ID_Producto: Number(row.ID_Producto || 0),
            Cantidad: Number(row.Cantidad ?? 1),
            Precio_Unitario: Number(row.Precio_Unitario ?? 0),
            Notas: row.Notas == null ? null : String(row.Notas),
            Estado_Cocina:
                row.Estado_Cocina == null ? null : String(row.Estado_Cocina),
            Pagado: Number(row.Pagado || 0),
            Nombre: String(row.Nombre || "Producto"),
        }));

        return json({ ok: true, result: out }, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", {
            message: String(e?.message || e),
        });
    }
}