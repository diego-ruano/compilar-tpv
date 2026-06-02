import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, unauthorized, serverError } from "../../../../utils/response";

export async function handleReservasGetMeta(
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
        const db: Client = (ctx.dbTenant ?? ctx.db ?? dbCentral) as Client;

        const tenantId = String(
            ctx?.claims?.tenantId ?? ctx?.tenantId ?? "",
        ).trim();

        if (!tenantId) return unauthorized(req, "invalid_token_claims");

        const zonas = await db.execute({
            sql: `
        SELECT ID_Zona as id_zona, Nombre_Zona as nombre_zona
        FROM Zonas
        ORDER BY ID_Zona ASC;
      `,
            args: [],
        });

        const mesas = await db.execute({
            sql: `
        SELECT
          ID_Mesa as id_mesa,
          ID_Zona as id_zona,
          Numero_Mesa as numero_mesa,
          Capacidad as capacidad
        FROM Mesas
        ORDER BY ID_Zona ASC, ID_Mesa ASC;
      `,
            args: [],
        });

        return json(
            {
                ok: true,
                data: {
                    zonas: (zonas.rows ?? []).map((r: any) => ({
                        id_zona: Number(r.id_zona ?? r.ID_Zona ?? 0),
                        nombre_zona: String(
                            r.nombre_zona ?? r.Nombre_Zona ?? "",
                        ),
                    })),
                    mesas: (mesas.rows ?? []).map((r: any) => ({
                        id_mesa: Number(r.id_mesa ?? r.ID_Mesa ?? 0),
                        id_zona: Number(r.id_zona ?? r.ID_Zona ?? 0),
                        numero_mesa: String(
                            r.numero_mesa ?? r.Numero_Mesa ?? "",
                        ),
                        capacidad: Number(r.capacidad ?? r.Capacidad ?? 0),
                    })),
                },
            },
            200,
            req,
        );
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}