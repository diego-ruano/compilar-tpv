// src/server/endpoints/rest/queries/tables/mesasLoadLayout.ts
import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, unauthorized, serverError } from "../../../../utils/response";

type RoomPoly = { type: string; points: number[] };

type TableOut = {
    id: string;
    name: string;
    x: number;
    y: number;
    width: number;
    height: number;
    radius?: number | null;
    seats: number;
    shape: string;
};

type SalonOut = {
    id: string;
    name: string;
    room: RoomPoly;
    tables: TableOut[];
};

export async function handleMesasLoadLayout(
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

        if (!ctx?.claims?.tenantId) {
            return unauthorized(req, "invalid_token_claims");
        }

        const zonasRes = await db.execute({
            sql: `
                SELECT ID_Zona, Nombre_Zona, Room_Points
                FROM Zonas
                WHERE UPPER(COALESCE(Nombre_Zona, '')) <> 'BARRA'
                ORDER BY ID_Zona ASC;
            `,
            args: [],
        });

        const mesasRes = await db.execute({
            sql: `
                SELECT
                  ID_Mesa,
                  ID_Zona,
                  Numero_Mesa,
                  Capacidad,
                  Ubicacion_X,
                  Ubicacion_Y,
                  Shape,
                  Width,
                  Height,
                  Radius
                FROM Mesas
                WHERE COALESCE(Es_Sistema, 0) = 0
                ORDER BY ID_Zona ASC, ID_Mesa ASC;
            `,
            args: [],
        });

        const byZona = new Map<number, TableOut[]>();

        for (const r of (mesasRes.rows || []) as any[]) {
            const idMesa = Number(r.ID_Mesa ?? r[0] ?? 0);
            const idZona = Number(r.ID_Zona ?? r[1] ?? 0);
            if (!idMesa || !idZona) continue;

            const name = String(r.Numero_Mesa ?? r[2] ?? `Mesa ${idMesa}`);
            const seats = Number(r.Capacidad ?? r[3] ?? 4);
            const x = Number(r.Ubicacion_X ?? r[4] ?? 0);
            const y = Number(r.Ubicacion_Y ?? r[5] ?? 0);
            const shape = String(r.Shape ?? r[6] ?? "rounded");
            const width = Number(r.Width ?? r[7] ?? 120);
            const height = Number(r.Height ?? r[8] ?? 70);
            const radius = r.Radius ?? r[9] ?? null;

            const arr = byZona.get(idZona) ?? [];
            arr.push({
                id: `db-mesa-${idMesa}`,
                name,
                x,
                y,
                width,
                height,
                radius: radius == null ? null : Number(radius),
                seats,
                shape,
            });
            byZona.set(idZona, arr);
        }

        const out: SalonOut[] = [];

        for (const z of (zonasRes.rows || []) as any[]) {
            const idZona = Number(z.ID_Zona ?? z[0] ?? 0);
            if (!idZona) continue;

            const name = String(z.Nombre_Zona ?? z[1] ?? `Zona ${idZona}`);
            const raw = String(z.Room_Points ?? z[2] ?? "[]");

            let points: number[] = [];
            try {
                const p = JSON.parse(raw);
                if (Array.isArray(p)) {
                    points = p
                        .map((n) => Number(n))
                        .filter((n) => Number.isFinite(n));
                }
            } catch {
                points = [];
            }

            out.push({
                id: `db-zona-${idZona}`,
                name,
                room: { type: "poly", points },
                tables: byZona.get(idZona) ?? [],
            });
        }

        return json(out, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}