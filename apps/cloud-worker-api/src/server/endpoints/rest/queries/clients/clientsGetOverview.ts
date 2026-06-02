// src/server/endpoints/rest/queries/clients/clientsGetOverview.ts

import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, unauthorized, serverError } from "../../../../utils/response";
import { readJsonSafe, unwrapArgs } from "../../../../utils/tenantHubWrites";

type Ranking = "todos" | "reservas" | "gasto";

type OverviewBody = {
  ranking?: Ranking;
};

function s(v: any): string {
  return String(v ?? "").trim();
}

function nI(v: any): number {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? Math.trunc(x) : 0;
}

function nF(v: any): number {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
}

function normOpt(v: any): string | null {
  const t = s(v);
  return t.length ? t : null;
}

function sqlOverviewBase(): string {
  return `
		SELECT
			c.ID_Cliente AS id_cliente,
			c.Nombre AS nombre,
			c.Email AS email,
			c.Telefono AS telefono,

			(
				SELECT r.Dia_YMD
				FROM Reservas r
				WHERE r.ID_Cliente = c.ID_Cliente
				ORDER BY r.Dia_YMD DESC, r.Hora DESC
				LIMIT 1
			) AS ultima_reserva_fecha,

			(
				SELECT r.Hora
				FROM Reservas r
				WHERE r.ID_Cliente = c.ID_Cliente
				ORDER BY r.Dia_YMD DESC, r.Hora DESC
				LIMIT 1
			) AS ultima_reserva_hora,

			(
				SELECT r.Comensales
				FROM Reservas r
				WHERE r.ID_Cliente = c.ID_Cliente
				ORDER BY r.Dia_YMD DESC, r.Hora DESC
				LIMIT 1
			) AS ultima_reserva_num_personas,

			(
				SELECT m.Numero_Mesa
				FROM Reservas r
				JOIN Mesas m ON m.ID_Mesa = r.ID_Mesa
				WHERE r.ID_Cliente = c.ID_Cliente
				ORDER BY r.Dia_YMD DESC, r.Hora DESC
				LIMIT 1
			) AS ultima_reserva_mesa,

			(
				SELECT IFNULL(SUM(f.Total_Pagado), 0)
				FROM Facturas f
				WHERE f.ID_Cliente = c.ID_Cliente
			) AS total_gastado_calculado,

			IFNULL(c.Total_Gastado, 0) AS total_gastado_stored,

			(
				SELECT COUNT(*)
				FROM Reservas r
				WHERE r.ID_Cliente = c.ID_Cliente
			) AS total_reservas,

			(
				SELECT COUNT(*)
				FROM Reservas r
				WHERE r.ID_Cliente = c.ID_Cliente
				  AND UPPER(COALESCE(r.Estado,'')) = 'ACTIVA'
				  AND date(r.Dia_YMD) >= date('now','localtime')
			) AS reservas_pendientes

		FROM Clientes c
	`;
}

export async function handleClientsGetOverview(
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

    const rawBody = await readJsonSafe<any>(req, {});
    const body = unwrapArgs<OverviewBody>(rawBody);

    const ranking: Ranking =
      body?.ranking === "reservas" || body?.ranking === "gasto"
        ? body.ranking
        : "todos";

    const base = sqlOverviewBase();

    const sql =
      ranking === "reservas"
        ? `
					${base}
					ORDER BY
						total_reservas DESC,
						(total_gastado_calculado + total_gastado_stored) DESC,
						c.ID_Cliente DESC
					LIMIT 10;
				`
        : ranking === "gasto"
          ? `
						${base}
						ORDER BY
							(total_gastado_calculado + total_gastado_stored) DESC,
							total_reservas DESC,
							c.ID_Cliente DESC
						LIMIT 10;
					`
          : `
						${base}
						ORDER BY c.ID_Cliente DESC;
					`;

    const r = await db.execute({ sql, args: [] });

    const out = (r.rows ?? []).map((row: any) => ({
      id_cliente: nI(row.id_cliente),
      nombre: s(row.nombre),
      email: normOpt(row.email),
      telefono: normOpt(row.telefono),

      ultima_reserva_fecha: normOpt(row.ultima_reserva_fecha),
      ultima_reserva_hora: normOpt(row.ultima_reserva_hora),
      ultima_reserva_num_personas:
        row.ultima_reserva_num_personas == null
          ? null
          : nI(row.ultima_reserva_num_personas),
      ultima_reserva_mesa: normOpt(row.ultima_reserva_mesa),

      total_gastado_calculado: nF(row.total_gastado_calculado),
      total_gastado_stored: nF(row.total_gastado_stored),

      total_reservas: nI(row.total_reservas),
      reservas_pendientes: nI(row.reservas_pendientes),
    }));

    return json({ ok: true, data: out }, 200, req);
  } catch (e: any) {
    return serverError(req, "internal_error", String(e?.message || e));
  }
}