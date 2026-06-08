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

async function tableHasColumn(
	db: Client,
	table: string,
	column: string,
): Promise<boolean> {
	const rs = await db.execute({ sql: `PRAGMA table_info(${table});` });
	return rows(rs).some(
		(r) => String(r.name ?? "").toLowerCase() === column.toLowerCase(),
	);
}

export async function meta(db: Client): Promise<ReservasMetaDto> {
	const zonasRs = await db.execute(`
		SELECT
			ID_Zona AS id_zona,
			Nombre_Zona AS nombre_zona
		FROM Zonas
		ORDER BY ID_Zona ASC;
	`);

	const hasEsSistema = await tableHasColumn(db, "Mesas", "Es_Sistema");
	const mesasRs = await db.execute(`
		SELECT
			ID_Mesa AS id_mesa,
			ID_Zona AS id_zona,
			Numero_Mesa AS numero_mesa,
			Capacidad AS capacidad
		FROM Mesas
		${hasEsSistema ? "WHERE COALESCE(Es_Sistema, 0) = 0" : ""}
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
			JOIN Clientes C ON C.ID_Cliente = R.ID_Cliente
			JOIN Mesas M ON M.ID_Mesa = R.ID_Mesa
			JOIN Zonas Z ON Z.ID_Zona = M.ID_Zona
			WHERE R.Dia_YMD >= ?1 AND R.Dia_YMD <= ?2
			ORDER BY R.Dia_YMD ASC, R.Hora ASC, R.ID_Reserva ASC;
		`,
		args: [desde, hasta],
	});
	return rows(rs) as ReservaDto[];
}

export async function findClienteReserva(
	db: Client,
	email: string | null,
	telefono: string | null,
): Promise<{ id_cliente: number; email: string | null } | null> {
	if (email) {
		const rs = await db.execute({
			sql: `
				SELECT
					ID_Cliente AS id_cliente,
					Email AS email
				FROM Clientes
				WHERE Email = ?1
				ORDER BY ID_Cliente DESC
				LIMIT 1;
			`,
			args: [email],
		});
		const row = rows(rs)[0];
		if (row) return row as { id_cliente: number; email: string | null };
	}

	if (telefono) {
		const rs = await db.execute({
			sql: `
				SELECT
					ID_Cliente AS id_cliente,
					Email AS email
				FROM Clientes
				WHERE Telefono = ?1
				ORDER BY ID_Cliente DESC
				LIMIT 1;
			`,
			args: [telefono],
		});
		const row = rows(rs)[0];
		if (row) return row as { id_cliente: number; email: string | null };
	}

	return null;
}
