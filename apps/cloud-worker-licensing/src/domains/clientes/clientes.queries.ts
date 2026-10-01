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

// Base del overview. En vez de ~6 subconsultas correlacionadas por cliente (coste
// O(clientes x reservas), CLI-02), se precalcula la última reserva y los agregados en
// dos CTEs que recorren `Reservas` una sola vez (paridad con el repo Rust). La salida
// (nombres de columnas) es IDÉNTICA. No se limita el número de filas: el ranking
// "Reciente" es la lista completa que el frontend usa para buscar/contar.
function overviewBase(): string {
	return `
		WITH ult_reserva AS (
			SELECT
				r.ID_Cliente,
				r.Dia_YMD,
				r.Hora,
				r.Comensales,
				r.ID_Mesa,
				ROW_NUMBER() OVER (
					PARTITION BY r.ID_Cliente
					ORDER BY r.Dia_YMD DESC, r.Hora DESC
				) AS rn
			FROM Reservas r
		),
		agg_reservas AS (
			SELECT
				r.ID_Cliente,
				COUNT(*) AS total_reservas,
				SUM(
					CASE
						WHEN UPPER(COALESCE(r.Estado,'')) = 'ACTIVA'
							AND date(r.Dia_YMD) >= date('now','localtime')
						THEN 1 ELSE 0
					END
				) AS reservas_pendientes
			FROM Reservas r
			GROUP BY r.ID_Cliente
		)
		SELECT
			c.ID_Cliente AS id_cliente,
			c.Nombre AS nombre,
			-- CLI-05: los textos opcionales salen NORMALIZADOS (trim + vacio a NULL) porque asi los
			-- devuelve la Main (norm_opt_string en tpv-infra-sqlite). Sin esto, un email guardado
			-- como cadena vacia llegaba aqui como "" y alli como null: el mismo cliente con ficha
			-- distinta en cada pantalla. Lo fija el harness de contrato de lectura.
			NULLIF(TRIM(c.Email), '') AS email,
			NULLIF(TRIM(c.Telefono), '') AS telefono,
			NULLIF(TRIM(ur.Dia_YMD), '') AS ultima_reserva_fecha,
			NULLIF(TRIM(ur.Hora), '') AS ultima_reserva_hora,
			ur.Comensales AS ultima_reserva_num_personas,
			NULLIF(TRIM(m.Numero_Mesa), '') AS ultima_reserva_mesa,
			IFNULL(c.Total_Gastado, 0) AS total_gastado_stored,
			COALESCE(ar.total_reservas, 0) AS total_reservas,
			COALESCE(ar.reservas_pendientes, 0) AS reservas_pendientes
		FROM Clientes c
		LEFT JOIN ult_reserva ur ON ur.ID_Cliente = c.ID_Cliente AND ur.rn = 1
		LEFT JOIN Mesas m ON m.ID_Mesa = ur.ID_Mesa
		LEFT JOIN agg_reservas ar ON ar.ID_Cliente = c.ID_Cliente
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
				ORDER BY total_reservas DESC, total_gastado_stored DESC, c.ID_Cliente DESC
				LIMIT 10;`
			: ranking.trim() === "gasto"
				? `${base}
					ORDER BY total_gastado_stored DESC, total_reservas DESC, c.ID_Cliente DESC
					LIMIT 10;`
				: `${base}
					ORDER BY c.Created_At DESC, c.ID_Cliente DESC;`;

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
				-- Mismo criterio que el overview (ver arriba): la Main normaliza estos tres.
				NULLIF(TRIM(Email), '') AS email,
				NULLIF(TRIM(Telefono), '') AS telefono,
				NULLIF(TRIM(Notas), '') AS notas
			FROM Clientes
			WHERE ID_Cliente = ?1
			LIMIT 1;
		`,
		args: [idCliente],
	});
	return (rows(rs)[0] ?? null) as ClienteForm | null;
}

// CLI-04: ¿hay ya otro cliente con este email? (case-insensitive; excluye `excluirId`
// para permitir re-guardar el mismo cliente). Backstop real es el índice único
// `ux_clientes_email`; este pre-check sólo da un 409 limpio en la ruta.
export async function emailEnUso(
	db: Client,
	email: string,
	excluirId?: string | null,
): Promise<boolean> {
	const rs = excluirId
		? await db.execute({
				sql: `SELECT 1 FROM Clientes WHERE lower(Email) = lower(?1) AND ID_Cliente <> ?2 LIMIT 1;`,
				args: [email, excluirId],
			})
		: await db.execute({
				sql: `SELECT 1 FROM Clientes WHERE lower(Email) = lower(?1) LIMIT 1;`,
				args: [email],
			});
	return rows(rs).length > 0;
}
