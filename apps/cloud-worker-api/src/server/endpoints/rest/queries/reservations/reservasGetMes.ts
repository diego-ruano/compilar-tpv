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

export async function handleReservasGetMes(
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

        const body = await readJsonSafe(req, { desde: "", hasta: "" });
        const desde = String((body as any).desde ?? "").trim();
        const hasta = String((body as any).hasta ?? "").trim();

        if (!desde || !hasta) {
            return json({ ok: false, error: "missing_range" }, 400, req);
        }

        const r = await db.execute({
            sql: `
        SELECT
          R.ID_Reserva as id_reserva,
          R.ID_Mesa as id_mesa,
          R.Dia_YMD as dia_ymd,
          R.Hora as hora,
          R.Turno as turno,
          R.Comensales as comensales,
          R.Nota as nota,
          R.Estado as estado,

          C.Nombre as nombre_cliente,
          C.Telefono as telefono_cliente,
          C.Email as email_cliente,

          M.ID_Zona as id_zona,
          M.Numero_Mesa as numero_mesa,
          M.Capacidad as capacidad,

          Z.Nombre_Zona as nombre_zona

        FROM Reservas R
        JOIN Clientes C ON C.ID_Cliente = R.ID_Cliente
        JOIN Mesas M ON M.ID_Mesa = R.ID_Mesa
        JOIN Zonas Z ON Z.ID_Zona = M.ID_Zona

        WHERE R.Dia_YMD >= ?1 AND R.Dia_YMD <= ?2
        ORDER BY R.Dia_YMD ASC, R.Hora ASC;
      `,
            args: [desde, hasta],
        });

        const out = (r.rows ?? []).map((x: any) => ({
            id_reserva: Number(x.id_reserva ?? x.ID_Reserva ?? 0),
            id_mesa: Number(x.id_mesa ?? x.ID_Mesa ?? 0),
            dia_ymd: String(x.dia_ymd ?? x.Dia_YMD ?? ""),
            hora: String(x.hora ?? x.Hora ?? ""),
            turno: x.turno ?? x.Turno ?? null,
            comensales: Number(x.comensales ?? x.Comensales ?? 0),
            nota: x.nota ?? x.Nota ?? null,
            estado: String(x.estado ?? x.Estado ?? ""),

            nombre_cliente: String(
                x.nombre_cliente ?? x.Nombre_Cliente ?? x.Nombre ?? "",
            ),
            telefono_cliente:
                x.telefono_cliente ?? x.Telefono_Cliente ?? x.Telefono ?? null,
            email_cliente:
                x.email_cliente ?? x.Email_Cliente ?? x.Email ?? null,

            id_zona: Number(x.id_zona ?? x.ID_Zona ?? 0),
            numero_mesa: String(x.numero_mesa ?? x.Numero_Mesa ?? ""),
            capacidad: Number(x.capacidad ?? x.Capacidad ?? 0),
            nombre_zona: String(x.nombre_zona ?? x.Nombre_Zona ?? ""),
        }));

        return json({ ok: true, data: out }, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}