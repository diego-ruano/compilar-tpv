// src/domains/clientes/clientes.queries.ts

import type { Client } from "@libsql/client/web";

import type { ClienteForm, ClienteOverview } from "@tpv/contracts";

function rows(rs: any): any[] {
	const cols: string[] = rs?.columns ?? [];
	return (rs?.rows ?? []).map((r: any) => {
		if (r && typeof r === "object" && !Array.isArray(r)) return r;
		const o: Record<string, any> = {};
		cols.forEach((col, i) => {
			o[col] = r[i];
		});
		return o;
	});
}

function overviewBase(): string {
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

export async function overview(
	db: Client,
	ranking: string,
): Promise<ClienteOverview[]> {
	const base = overviewBase();
	const sql =
		ranking.trim() === "reservas"
			? `${base}
				ORDER BY total_reservas DESC, (total_gastado_calculado + total_gastado_stored) DESC, c.ID_Cliente DESC
				LIMIT 10;`
			: ranking.trim() === "gasto"
				? `${base}
					ORDER BY (total_gastado_calculado + total_gastado_stored) DESC, total_reservas DESC, c.ID_Cliente DESC
					LIMIT 10;`
				: `${base}
					ORDER BY c.ID_Cliente DESC;`;

	const rs = await db.execute(sql);
	return rows(rs) as ClienteOverview[];
}

export async function form(
	db: Client,
	idCliente: string,
): Promise<ClienteForm | null> {
	const rs = await db.execute({
		sql: `
			SELECT
				Nombre AS nombre,
				Email AS email,
				Telefono AS telefono,
				Notas AS notas
			FROM Clientes
			WHERE ID_Cliente = ?1
			LIMIT 1;
		`,
		args: [idCliente],
	});
	return (rows(rs)[0] ?? null) as ClienteForm | null;
}
