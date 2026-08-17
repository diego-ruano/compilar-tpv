// src/domains/trabajadores/trabajadores.queries.ts

import type { Client } from "@libsql/client/web";

import type {
	AsignacionRow,
	RolRow,
	TrabajadorDetailRow,
	TrabajadorRow,
	TurnoRow,
} from "@tpv/contracts";

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

// TRAB-04: ¿ya existe una asignación del mismo turno para ese trabajador ese día? Espejo de la
// comprobación del repo local (el área puede diferir; el duplicado es trabajador+fecha+turno).
export async function existeAsignacionTurno(
	db: Client,
	idTrabajador: string,
	fecha: string,
	idTurno: string,
): Promise<boolean> {
	const rs = await db.execute({
		sql: "SELECT 1 FROM Asignacion_Turnos WHERE ID_Trabajador = ?1 AND Fecha = date(?2) AND ID_Turno = ?3 LIMIT 1;",
		args: [idTrabajador, fecha, idTurno],
	});
	return rows(rs).length > 0;
}

function ymdToDate(ymd: string): Date {
	const [y, m, d] = ymd.split("-").map(Number);
	return new Date(Date.UTC(y, m - 1, d));
}

function dateToYmd(d: Date): string {
	return d.toISOString().slice(0, 10);
}

function addDays(ymd: string, days: number): string {
	const d = ymdToDate(ymd);
	d.setUTCDate(d.getUTCDate() + days);
	return dateToYmd(d);
}

function currentMonday(): string {
	const d = new Date();
	const utc = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
	const weekday = utc.getUTCDay() || 7;
	utc.setUTCDate(utc.getUTCDate() - (weekday - 1));
	return dateToYmd(utc);
}

function weekday1To7(ymd: string): number {
	const d = ymdToDate(ymd);
	return d.getUTCDay() || 7;
}

function hhmm(v: unknown): string {
	return String(v ?? "").slice(0, 5);
}

export async function roles(db: Client): Promise<RolRow[]> {
	const rs = await db.execute(`
		SELECT
			ID_Rol AS ID_Rol,
			Nombre_Rol AS Nombre_Rol
		FROM Roles
		ORDER BY Nombre_Rol ASC;
	`);
	return rows(rs) as RolRow[];
}

export async function all(db: Client): Promise<TrabajadorRow[]> {
	const rs = await db.execute(`
		SELECT
			t.ID_Trabajador AS ID_Trabajador,
			t.ID_Usuario AS ID_Usuario,
			u.Nombre AS Nombre,
			u.Apellido AS Apellido,
			u.Email AS Email,
			COALESCE(u.Estado, 'Activo') AS Estado,
			r.Nombre_Rol AS Nombre_Rol,
			t.Telefono AS Telefono,
			t.Puesto AS Puesto
		FROM Trabajadores t
		JOIN Usuarios u ON u.ID_Usuario = t.ID_Usuario
		JOIN Roles r ON r.ID_Rol = u.ID_Rol
		ORDER BY u.Nombre ASC;
	`);
	return rows(rs) as TrabajadorRow[];
}

export async function detail(
	db: Client,
	idTrabajador: string,
): Promise<TrabajadorDetailRow | null> {
	const rs = await db.execute({
		sql: `
			SELECT
				t.ID_Trabajador AS ID_Trabajador,
				t.ID_Usuario AS ID_Usuario,
				u.ID_Rol AS ID_Rol,
				u.Email AS Email,
				u.Nombre AS Nombre,
				u.Apellido AS Apellido,
				COALESCE(u.Estado, 'Activo') AS Estado,
				-- TRAB-03: DNI, IBAN y Numero_Seguridad_Social se omiten. Están cifrados con una
				-- clave que sólo tiene la Main, así que devolverlos aquí sólo serviría para que
				-- la Handy pintara un churro. Llegan como NULL y su UI no los muestra.
				NULL AS DNI,
				t.Telefono AS Telefono,
				t.Puesto AS Puesto,
				NULL AS IBAN,
				NULL AS Numero_Seguridad_Social,
				t.Fecha_Inicio_Contrato AS Fecha_Inicio_Contrato,
				t.Fecha_Fin_Contrato AS Fecha_Fin_Contrato
			FROM Trabajadores t
			JOIN Usuarios u ON u.ID_Usuario = t.ID_Usuario
			WHERE t.ID_Trabajador = ?1
			LIMIT 1;
		`,
		args: [idTrabajador],
	});
	return (rows(rs)[0] ?? null) as TrabajadorDetailRow | null;
}

export async function idByUsuario(
	db: Client,
	idUsuario: string,
): Promise<number | null> {
	const rs = await db.execute({
		sql: `
			SELECT ID_Trabajador AS id
			FROM Trabajadores
			WHERE ID_Usuario = ?1
			LIMIT 1;
		`,
		args: [idUsuario],
	});
	const id = Number(rows(rs)[0]?.id ?? 0);
	return id > 0 ? id : null;
}

export async function turnos(db: Client): Promise<TurnoRow[]> {
	const rs = await db.execute(`
		SELECT
			ID_Turno AS ID_Turno,
			Nombre_Turno AS Nombre_Turno
		FROM Turnos
		ORDER BY
			CASE WHEN Nombre_Turno = 'LIBRE' THEN 0 ELSE 1 END,
			Nombre_Turno ASC;
	`);
	return rows(rs) as TurnoRow[];
}

export async function asignacionesSemana(
	db: Client,
	fechaLunes: string,
): Promise<AsignacionRow[]> {
	const rs = await db.execute({
		sql: `
			SELECT
				a.ID_Asignacion AS ID_Asignacion,
				a.ID_Trabajador AS ID_Trabajador,
				a.Fecha AS Fecha,
				a.ID_Turno AS ID_Turno,
				COALESCE(a.Area, 'Sala') AS Area,
				a.Hora_Inicio AS Hora_Inicio,
				a.Hora_Fin AS Hora_Fin,
				a.Notas AS Notas,
				t.Nombre_Turno AS Nombre_Turno
			FROM Asignacion_Turnos a
			JOIN Turnos t ON t.ID_Turno = a.ID_Turno
			WHERE a.Fecha >= date(?1)
				AND a.Fecha < date(?1, '+7 day')
			ORDER BY a.Fecha ASC, a.ID_Trabajador ASC, a.Hora_Inicio ASC;
		`,
		args: [fechaLunes],
	});

	const out = rows(rs) as AsignacionRow[];
	if (fechaLunes < currentMonday()) return out;

	const realCells = new Set(
		out.map((a: any) => `${a.ID_Trabajador}:${a.Fecha}`),
	);

	const defsRs = await db.execute(`
		SELECT
			h.ID_Trabajador AS ID_Trabajador,
			h.Weekday AS Weekday,
			h.Orden AS Orden,
			h.ID_Turno AS ID_Turno,
			COALESCE(h.Area, 'Sala') AS Area,
			h.Hora_Inicio AS Hora_Inicio,
			h.Hora_Fin AS Hora_Fin,
			h.Notas AS Notas,
			t.Nombre_Turno AS Nombre_Turno
		FROM Horario_Predeterminado h
		JOIN Turnos t ON t.ID_Turno = h.ID_Turno
		ORDER BY h.ID_Trabajador, h.Weekday, h.Orden;
	`);

	const defs = rows(defsRs);
	for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
		const fecha = addDays(fechaLunes, dayOffset);
		const weekday = dayOffset + 1;
		for (const d of defs) {
			const idTrab = String(d.ID_Trabajador ?? "");
			if (Number(d.Weekday ?? 0) !== weekday || !idTrab) continue;
			if (realCells.has(`${idTrab}:${fecha}`)) continue;
			out.push({
				ID_Asignacion: "",
				ID_Trabajador: idTrab,
				Fecha: fecha,
				ID_Turno: String(d.ID_Turno ?? ""),
				Area: String(d.Area ?? "Sala"),
				Hora_Inicio: d.Hora_Inicio ?? null,
				Hora_Fin: d.Hora_Fin ?? null,
				Notas: d.Notas ?? null,
				Nombre_Turno: String(d.Nombre_Turno ?? ""),
			} as AsignacionRow);
		}
	}

	out.sort((a: any, b: any) =>
		String(a.Fecha)
			.localeCompare(String(b.Fecha))
			|| String(a.ID_Trabajador).localeCompare(String(b.ID_Trabajador))
			|| hhmm(a.Hora_Inicio).localeCompare(hhmm(b.Hora_Inicio)),
	);
	return out;
}

export type PredeterminadoItem = {
	id_trabajador: string;
	weekday: number;
	orden: number;
	id_turno: string;
	area: string;
	hora_inicio: string | null;
	hora_fin: string | null;
	notas: string | null;
};

export async function predeterminadoDesdeSemanaItems(
	db: Client,
	fechaLunes: string,
): Promise<PredeterminadoItem[]> {
	const rs = await db.execute({
		sql: `
			SELECT
				a.ID_Trabajador AS id_trabajador,
				a.Fecha AS fecha,
				a.ID_Turno AS id_turno,
				COALESCE(a.Area, 'Sala') AS area,
				a.Hora_Inicio AS hora_inicio,
				a.Hora_Fin AS hora_fin,
				a.Notas AS notas
			FROM Asignacion_Turnos a
			WHERE a.Fecha >= date(?1)
				AND a.Fecha < date(?1, '+7 day')
			ORDER BY a.ID_Trabajador ASC, a.Fecha ASC, a.Hora_Inicio ASC;
		`,
		args: [fechaLunes],
	});

	const counters = new Map<string, number>();
	return rows(rs)
		.map((r) => {
			const idTrab = String(r.id_trabajador ?? "");
			const fecha = String(r.fecha ?? "");
			const weekday = weekday1To7(fecha);
			const key = `${idTrab}:${weekday}`;
			const orden = (counters.get(key) ?? 0) + 1;
			counters.set(key, orden);
			return {
				id_trabajador: idTrab,
				weekday,
				orden,
				id_turno: String(r.id_turno ?? ""),
				area: String(r.area ?? "Sala"),
				hora_inicio: r.hora_inicio ?? null,
				hora_fin: r.hora_fin ?? null,
				notas: r.notas ?? null,
			};
		})
		.filter(
			(r) =>
				r.id_trabajador.trim().length > 0
				&& r.weekday >= 1
				&& r.weekday <= 7
				&& r.id_turno.trim().length > 0,
		);
}
