// src/domains/reservas/reservas.queries.ts

import type { Client } from "@libsql/client/web";

import type { ReservaDto, ReservasMetaDto } from "@tpv/contracts";

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

export async function meta(db: Client): Promise<ReservasMetaDto> {
	const zonasRs = await db.execute(`
		SELECT
			ID_Zona AS id_zona,
			Nombre_Zona AS nombre_zona
		FROM Zonas
		ORDER BY ID_Zona ASC;
	`);

	// Todas las mesas son reservables: ya no existen "mesas de sistema" (la venta rápida no usa
	// mesa, ver `Comandas.Canal`), así que no hay nada que excluir. Espejo del repo local.
	const mesasRs = await db.execute(`
		SELECT
			ID_Mesa AS id_mesa,
			ID_Zona AS id_zona,
			Numero_Mesa AS numero_mesa,
			Capacidad AS capacidad
		FROM Mesas
		ORDER BY ID_Zona ASC, ID_Mesa ASC;
	`);

	return {
		zonas: rows(zonasRs) as ReservasMetaDto["zonas"],
		mesas: rows(mesasRs) as ReservasMetaDto["mesas"],
	};
}

export async function mes(
	db: Client,
	desde: string,
	hasta: string,
): Promise<ReservaDto[]> {
	const rs = await db.execute({
		sql: `
			SELECT
				R.ID_Reserva AS id_reserva,
				R.ID_Mesa AS id_mesa,
				R.Dia_YMD AS dia_ymd,
				R.Hora AS hora,
				R.Turno AS turno,
				R.Comensales AS comensales,
				R.Nota AS nota,
				R.Estado AS estado,
				C.Nombre AS nombre_cliente,
				C.Telefono AS telefono_cliente,
				C.Email AS email_cliente,
				M.ID_Zona AS id_zona,
				M.Numero_Mesa AS numero_mesa,
				M.Capacidad AS capacidad,
				Z.Nombre_Zona AS nombre_zona
			FROM Reservas R
			LEFT JOIN Clientes C ON C.ID_Cliente = R.ID_Cliente
			LEFT JOIN Mesas M ON M.ID_Mesa = R.ID_Mesa
			LEFT JOIN Zonas Z ON Z.ID_Zona = M.ID_Zona
			WHERE R.Dia_YMD >= ?1 AND R.Dia_YMD <= ?2
			ORDER BY R.Dia_YMD ASC, R.Hora ASC, R.ID_Reserva ASC;
		`,
		args: [desde, hasta],
	});
	return rows(rs) as ReservaDto[];
}

// RES-02: ¿hay ya una reserva que ocupe el mismo hueco exacto (mesa+día+hora)? Excluye la
// propia reserva (edición) y los estados que no ocupan (cancelada/no-show/finalizada). Espejo
// de la comprobación autoritativa del repo local.
export async function haySolapeReserva(
	db: Client,
	idMesa: string,
	diaYmd: string,
	hora: string,
	idReservaExcluir: string | null,
): Promise<boolean> {
	const rs = await db.execute({
		sql: `
			SELECT 1
			FROM Reservas
			WHERE ID_Mesa = ?1 AND Dia_YMD = ?2 AND Hora = ?3
				AND Estado NOT IN ('CANCELADA','NO_SHOW','FINALIZADA')
				AND ID_Reserva <> ?4
			LIMIT 1;
		`,
		args: [idMesa, diaYmd, hora, idReservaExcluir ?? ""],
	});
	return rows(rs).length > 0;
}

export type ClienteExistente = {
	id_cliente: string;
	nombre: string | null;
	email: string | null;
	telefono: string | null;
	notas: string | null;
};

// RES-01: trae TODOS los campos del cliente existente para poder rellenar solo los vacíos
// (sin sobrescribir datos con valor). Busca por email y, si no, por teléfono.
export async function findClienteReserva(
	db: Client,
	email: string | null,
	telefono: string | null,
): Promise<ClienteExistente | null> {
	const COLS = `
		ID_Cliente AS id_cliente,
		Nombre AS nombre,
		Email AS email,
		Telefono AS telefono,
		Notas AS notas
	`;

	if (email) {
		const rs = await db.execute({
			sql: `SELECT ${COLS} FROM Clientes WHERE Email = ?1 ORDER BY ID_Cliente DESC LIMIT 1;`,
			args: [email],
		});
		const row = rows(rs)[0];
		if (row) return row as ClienteExistente;
	}

	if (telefono) {
		const rs = await db.execute({
			sql: `SELECT ${COLS} FROM Clientes WHERE Telefono = ?1 ORDER BY ID_Cliente DESC LIMIT 1;`,
			args: [telefono],
		});
		const row = rows(rs)[0];
		if (row) return row as ClienteExistente;
	}

	return null;
}
