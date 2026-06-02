// src/server/endpoints/rest/queries/tables/comandasGetAbiertaByMesa.ts
import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, unauthorized, serverError } from "../../../../utils/response";

async function readJsonSafe<T>(req: Request, fallback: T): Promise<T> {
    try {
        return (await req.json()) as T;
    } catch {
        return fallback;
    }
}

export async function handleComandasGetAbiertaByMesa(
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

        const body = await readJsonSafe(req, { id_mesa: 0 });
        const idMesa = Number(
            (body as any).id_mesa ?? (body as any).idMesa ?? 0,
        );
        if (!idMesa) return json(null, 200, req);

        const r = await db.execute({
            sql: `
        SELECT
          ID_Comanda, ID_Mesa, ID_Trabajador, ID_Reserva,
          Fecha_Hora_Apertura, Fecha_Hora_Cierre, Total_Comanda, Estado
        FROM Comandas
        WHERE ID_Mesa = ?1 AND Estado = 'Abierta'
        ORDER BY ID_Comanda DESC
        LIMIT 1;
      `,
            args: [idMesa],
        });

        const row: any = r.rows?.[0];
        if (!row) return json(null, 200, req);

        const out = {
            id_comanda: Number(row.ID_Comanda ?? row[0] ?? 0),
            id_mesa: Number(row.ID_Mesa ?? row[1] ?? 0),
            id_trabajador: row.ID_Trabajador ?? row[2] ?? null,
            id_reserva: row.ID_Reserva ?? row[3] ?? null,
            fecha_hora_apertura: String(
                row.Fecha_Hora_Apertura ?? row[4] ?? "",
            ),
            fecha_hora_cierre: row.Fecha_Hora_Cierre ?? row[5] ?? null,
            total_comanda: Number(row.Total_Comanda ?? row[6] ?? 0),
            estado: String(row.Estado ?? row[7] ?? "Abierta"),
        };

        return json(out, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}
