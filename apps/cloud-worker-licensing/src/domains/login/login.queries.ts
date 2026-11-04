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
			r.Nombre_Rol AS nombre_rol,
			u.Sin_PIN AS sin_pin
		FROM Usuarios u
		JOIN Roles r ON r.ID_Rol = u.ID_Rol
		WHERE u.Estado = 'Activo'
		ORDER BY u.Nombre ASC;
	`);
	// SQLite da 0/1 y la Main deserializa un booleano.
	return rows(rs).map((r) => ({ ...r, sin_pin: Number(r.sin_pin) === 1 })) as UserListItem[];
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
				r.Nombre_Rol AS rol,
				u.Sin_PIN AS sin_pin
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
		// LOGIN-06: email ausente → cadena vacía explícita (no un 'admin@local' falso).
		email: r.email == null ? "" : String(r.email),
		requiere_setup: Number(r.requiere_setup ?? 0),
	};
}

/* =========================================================
   Anti brute-force del PIN (LOGIN-01). Estado en Intentos_Login de la BD de tenant (device/tenant
   local, NO se replica). La política de backoff es espejo de tpv-domain::login::login_bloqueo_ms.
========================================================= */

const INTENTOS_LIBRES = 5;

function bloqueoMs(fallidos: number): number {
	if (fallidos <= INTENTOS_LIBRES) return 0;
	switch (fallidos - INTENTOS_LIBRES) {
		case 1:
			return 30_000;
		case 2:
			return 60_000;
		case 3:
			return 5 * 60_000;
		default:
			return 15 * 60_000;
	}
}

/** Segundos que faltan para poder reintentar (0 si no está bloqueado). */
export async function throttleSecondsLeft(db: Client, idUsuario: string): Promise<number> {
	const rs = await db.execute({
		sql: "SELECT Bloqueado_Hasta_Ms AS hasta FROM Intentos_Login WHERE ID_Usuario=?1 LIMIT 1;",
		args: [idUsuario],
	});
	const hasta = Number(rows(rs)[0]?.hasta ?? 0);
	const now = Date.now();
	return hasta > now ? Math.ceil((hasta - now) / 1000) : 0;
}

/** Resetea el contador tras un login correcto. */
export async function throttleReset(db: Client, idUsuario: string): Promise<void> {
	await db.execute({
		sql: "DELETE FROM Intentos_Login WHERE ID_Usuario=?1;",
		args: [idUsuario],
	});
}

/** Registra un fallo: incrementa el contador y fija el bloqueo escalado. */
export async function throttleFail(db: Client, idUsuario: string): Promise<void> {
	const rs = await db.execute({
		sql: "SELECT Intentos_Fallidos AS n FROM Intentos_Login WHERE ID_Usuario=?1 LIMIT 1;",
		args: [idUsuario],
	});
	const fallidos = Number(rows(rs)[0]?.n ?? 0) + 1;
	const now = Date.now();
	const hasta = now + bloqueoMs(fallidos);
	await db.execute({
		sql: `
			INSERT INTO Intentos_Login (ID_Usuario, Intentos_Fallidos, Bloqueado_Hasta_Ms, Ultimo_Intento_Ms)
			VALUES (?1, ?2, ?3, ?4)
			ON CONFLICT(ID_Usuario) DO UPDATE SET
				Intentos_Fallidos = excluded.Intentos_Fallidos,
				Bloqueado_Hasta_Ms = excluded.Bloqueado_Hasta_Ms,
				Ultimo_Intento_Ms = excluded.Ultimo_Intento_Ms;
		`,
		args: [idUsuario, fallidos, hasta, now],
	});
}

/**
 * Escritura DIRECTA del setup inicial en la Turso del tenant (mismo UPDATE que aplica el
 * comando `complete_initial_setup` vía el hub). Se usa para la SUBIDA desde la Main, que no
 * está conectada por WebSocket: por eso no pasa por el Durable Object (evita el `main_offline`).
 */
export async function applyInitialSetupDirect(
	db: Client,
	input: { idUsuario: string; passwordHash: string },
): Promise<void> {
	await db.execute({
		sql: `
			UPDATE Usuarios
			SET Password_Hash = ?2, Requiere_Setup = 0
			WHERE ID_Usuario = ?1;
		`,
		args: [input.idUsuario, input.passwordHash],
	});
}

/**
 * RI-05: la entrada más antigua que todavía cuenta como jornada en curso. La jornada se busca por su
 * hora de entrada y no por su `Fecha`, porque el turno de noche ficha la salida al día siguiente.
 * Pasado este margen el fichaje se da por olvidado y lo cierra el job `fichajes_colgados` de la Main.
 * El porqué de las 16 h, en `INICIO_MAS_ANTIGUO` de `tpv-infra-sqlite/src/login.rs`: es el mismo
 * valor y tiene que seguir siéndolo.
 */
const INICIO_MAS_ANTIGUO = "datetime('now','localtime','-16 hours')";

/** «Hoy» de quien pregunta (REV-03: `tenantQuery` fija su hora antes de ejecutar). */
export async function hoy(db: Client): Promise<string> {
	const fechaRs = await db.execute("SELECT date('now','localtime') AS fecha;");
	return String(rows(fechaRs)[0]?.fecha ?? "");
}

/**
 * RI-05: con una jornada en curso, el estado es el de SU día aunque empezara ayer. La pantalla elige
 * entre entrada y salida mirando este estado; con el de hoy, a la 01:30 un turno de noche aparecía
 * sin empezar y se fichaba una entrada nueva.
 */
export async function punchStatus(db: Client, idUsuario: string): Promise<PunchStatus> {
	const enCurso = await getOpenPunch(db, idUsuario);
	const fecha = enCurso ? enCurso.fecha : await hoy(db);
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

/** La jornada en curso del usuario (ver `INICIO_MAS_ANTIGUO`), sea del día que sea. */
export async function getOpenPunch(
	db: Client,
	idUsuario: string,
): Promise<{ id_fichaje: string; fecha: string } | null> {
	const rs = await db.execute({
		sql: `
			SELECT ID_Fichaje AS id_fichaje, Fecha AS fecha
			FROM Fichajes
			WHERE ID_Usuario=?1
				AND Estado='ABIERTO'
				AND Hora_Entrada IS NOT NULL
				AND Hora_Salida IS NULL
				AND Hora_Entrada >= ${INICIO_MAS_ANTIGUO}
			ORDER BY Hora_Entrada DESC, ID_Fichaje DESC
			LIMIT 1;
		`,
		args: [idUsuario],
	});
	const r = rows(rs)[0];
	return r ? { id_fichaje: String(r.id_fichaje), fecha: String(r.fecha) } : null;
}

export async function nextPunchPart(db: Client, idUsuario: string, fecha: string) {
	// RI-05: el abierto que bloquea puede ser de ayer (un turno de noche sin cerrar).
	if (await getOpenPunch(db, idUsuario)) {
		throw new Error("Tienes un fichaje abierto. Ficha salida antes de fichar entrada.");
	}
	const status = await punchStatusForDate(db, idUsuario, fecha);
	const p1 = status.partes.find((p) => p.parte === 1);
	if (!p1) return 1;
	if (!p1.salida) throw new Error("La Parte 1 no esta cerrada. Ficha salida primero.");
	if (status.turno_partido === 1 && !status.partes.some((p) => p.parte === 2)) return 2;
	if (status.turno_partido === 1) throw new Error("Ya has completado el turno partido hoy.");
	throw new Error("Hoy no tienes turno partido. Ya has fichado el dia.");
}
