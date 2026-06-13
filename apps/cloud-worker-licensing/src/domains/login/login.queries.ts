// src/domains/login/login.queries.ts

import type { Client } from "@libsql/client/web";

import type { LoginOk, PunchStatus, UserListItem } from "@tpv/contracts";

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

export async function listLoginUsers(db: Client): Promise<UserListItem[]> {
	const rs = await db.execute(`
		SELECT
			u.ID_Usuario AS id_usuario,
			u.Nombre AS nombre,
			u.Apellido AS apellido,
			r.Nombre_Rol AS nombre_rol
		FROM Usuarios u
		JOIN Roles r ON r.ID_Rol = u.ID_Rol
		WHERE u.Estado = 'Activo'
		ORDER BY u.Nombre ASC;
	`);
	return rows(rs) as UserListItem[];
}

export async function getLoginRecord(db: Client, idUsuario: string): Promise<any | null> {
	const rs = await db.execute({
		sql: `
			SELECT
				u.ID_Usuario AS id_usuario,
				t.ID_Trabajador AS id_trabajador,
				u.Nombre AS nombre,
				u.Apellido AS apellido,
				u.Email AS email,
				u.Password_Hash AS password_hash,
				u.Requiere_Setup AS requiere_setup,
				r.Nombre_Rol AS rol
			FROM Usuarios u
			JOIN Roles r ON r.ID_Rol = u.ID_Rol
			LEFT JOIN Trabajadores t ON t.ID_Usuario = u.ID_Usuario
			WHERE u.ID_Usuario = ?1 AND u.Estado = 'Activo'
			LIMIT 1;
		`,
		args: [idUsuario],
	});
	return rows(rs)[0] ?? null;
}

export async function loginOk(db: Client, idUsuario: string): Promise<LoginOk | null> {
	const r = await getLoginRecord(db, idUsuario);
	if (!r) return null;
	return {
		id_usuario: String(r.id_usuario ?? ""),
		id_trabajador: r.id_trabajador == null ? null : String(r.id_trabajador),
		nombre: String(r.nombre ?? ""),
		apellido: r.apellido == null ? null : String(r.apellido),
		rol: String(r.rol ?? "Sin rol"),
		email: String(r.email ?? "admin@local"),
		requiere_setup: Number(r.requiere_setup ?? 0),
	};
}

/**
 * Escritura DIRECTA del setup inicial en la Turso del tenant (mismo UPDATE que aplica el
 * comando `complete_initial_setup` vía el hub). Se usa para la SUBIDA desde la Main, que no
 * está conectada por WebSocket: por eso no pasa por el Durable Object (evita el `main_offline`).
 */
export async function applyInitialSetupDirect(
	db: Client,
	input: { idUsuario: string; email: string; passwordHash: string },
): Promise<void> {
	await db.execute({
		sql: `
			UPDATE Usuarios
			SET Email = ?2, Password_Hash = ?3, Requiere_Setup = 0
			WHERE ID_Usuario = ?1;
		`,
		args: [input.idUsuario, input.email, input.passwordHash],
	});
}

export async function emailInUse(
	db: Client,
	email: string,
	excludeId: string,
): Promise<boolean> {
	const rs = await db.execute({
		sql: `
			SELECT COUNT(*) AS count
			FROM Usuarios
			WHERE Email = ?1 AND ID_Usuario <> ?2;
		`,
		args: [email, excludeId],
	});
	return Number(rows(rs)[0]?.count ?? 0) > 0;
}

export async function punchStatus(db: Client, idUsuario: string): Promise<PunchStatus> {
	const fechaRs = await db.execute("SELECT date('now','localtime') AS fecha;");
	const fecha = String(rows(fechaRs)[0]?.fecha ?? "");
	return punchStatusForDate(db, idUsuario, fecha);
}

export async function punchStatusForDate(
	db: Client,
	idUsuario: string,
	fecha: string,
): Promise<PunchStatus> {
	const turnoRs = await db.execute({
		sql: `
			SELECT Turno_Partido AS turno_partido
			FROM Fichaje_Dia
			WHERE ID_Usuario=?1 AND Fecha=?2
			LIMIT 1;
		`,
		args: [idUsuario, fecha],
	});
	const partesRs = await db.execute({
		sql: `
			SELECT
				Parte AS parte,
				Hora_Entrada AS entrada,
				Hora_Salida AS salida,
				Estado AS estado
			FROM Fichajes
			WHERE ID_Usuario=?1 AND Fecha=?2
			ORDER BY Parte ASC;
		`,
		args: [idUsuario, fecha],
	});
	return {
		fecha,
		turno_partido: Number(rows(turnoRs)[0]?.turno_partido ?? 0),
		partes: rows(partesRs).map((r) => ({
			parte: Number(r.parte ?? 1),
			entrada: r.entrada == null ? null : String(r.entrada),
			salida: r.salida == null ? null : String(r.salida),
			estado: String(r.estado ?? "ABIERTO"),
		})),
	};
}

export async function getOpenPunch(db: Client, idUsuario: string, fecha: string) {
	const rs = await db.execute({
		sql: `
			SELECT ID_Fichaje AS id_fichaje, Parte AS parte
			FROM Fichajes
			WHERE ID_Usuario=?1 AND Fecha=?2
				AND Estado='ABIERTO'
				AND Hora_Entrada IS NOT NULL
				AND Hora_Salida IS NULL
			ORDER BY Parte DESC
			LIMIT 1;
		`,
		args: [idUsuario, fecha],
	});
	return rows(rs)[0] ?? null;
}

export async function nextPunchPart(db: Client, idUsuario: string, fecha: string) {
	const status = await punchStatusForDate(db, idUsuario, fecha);
	const open = status.partes.find((p) => p.estado === "ABIERTO" && p.entrada && !p.salida);
	if (open) throw new Error("Tienes un fichaje abierto. Ficha salida antes de fichar entrada.");
	const p1 = status.partes.find((p) => p.parte === 1);
	if (!p1) return 1;
	if (!p1.salida) throw new Error("La Parte 1 no esta cerrada. Ficha salida primero.");
	if (status.turno_partido === 1 && !status.partes.some((p) => p.parte === 2)) return 2;
	if (status.turno_partido === 1) throw new Error("Ya has completado el turno partido hoy.");
	throw new Error("Hoy no tienes turno partido. Ya has fichado el dia.");
}
