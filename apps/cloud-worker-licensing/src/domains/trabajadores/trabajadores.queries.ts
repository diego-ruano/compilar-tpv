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

// TRAB-08: filas de la semana origen para copiarla. Se leen aquí, igual que hace el repo de Rust,
// porque el ID de cada copia NO puede salir de la propia sentencia: lo que se replica es el texto
// SQL, así que un `randomblob()` dentro del INSERT se evalúa otra vez en la Main y deja claves
// distintas a cada lado. El ID tiene que ser un literal antes de escribir.
export type GrupoAsignacion = { id_grupo: string; ids: string[] };

export async function grupoAsignacion(db: Client, id: string): Promise<GrupoAsignacion | null> {
	const resultado = await db.execute({ sql: "SELECT ID_Asignacion, COALESCE(ID_Grupo, ID_Asignacion) AS ID_Grupo FROM Asignacion_Turnos WHERE COALESCE(ID_Grupo, ID_Asignacion) = (SELECT COALESCE(ID_Grupo, ID_Asignacion) FROM Asignacion_Turnos WHERE ID_Asignacion = ?1) ORDER BY Hora_Inicio, ID_Asignacion;", args: [id] });
	const miembros = rows(resultado);
	return miembros.length ? { id_grupo: String(miembros[0].ID_Grupo), ids: miembros.map(m => String(m.ID_Asignacion)) } : null;
}

export type FilaSemanaOrigen = {
	id_grupo?: string | null;
	id_trabajador: string;
	fecha: string;
	id_turno: string;
	area: string;
	hora_inicio: string | null;
	hora_fin: string | null;
	notas: string | null;
};

export async function filasSemana(
	db: Client,
	fromMonday: string,
): Promise<FilaSemanaOrigen[]> {
	const rs = await db.execute({
		sql: `
			SELECT
				ID_Trabajador AS id_trabajador,
				ID_Grupo AS id_grupo,
				Fecha AS fecha,
				ID_Turno AS id_turno,
				Area AS area,
				Hora_Inicio AS hora_inicio,
				Hora_Fin AS hora_fin,
				Notas AS notas
			FROM Asignacion_Turnos
			WHERE Fecha >= date(?1)
				AND Fecha < date(?1, '+7 day');
		`,
		args: [fromMonday],
	});
	return rows(rs) as FilaSemanaOrigen[];
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

/**
 * RI-62: ¿editar esta ficha deja el negocio sin ningún administrador activo? Sí cuando el usuario es
 * administrador activo, deja de serlo (otro rol, o `Inactivo`) y no queda ningún otro. Sólo se mira
 * el paso de «hay» a «no hay». El porqué, en `SQL_DEJARIA_SIN_ADMINISTRADOR` de
 * `tpv-infra-sqlite/src/trabajadores.rs`: es el mismo SQL y tiene que seguir siéndolo.
 */
export async function dejariaSinAdministrador(
	db: Client,
	idUsuario: string,
	idRolNuevo: string,
	estadoNuevo: string,
): Promise<boolean> {
	const rs = await db.execute({
		sql: `
			SELECT
				EXISTS (
					SELECT 1 FROM Usuarios u JOIN Roles r ON r.ID_Rol = u.ID_Rol
					WHERE u.ID_Usuario = ?1 AND u.Estado = 'Activo' AND r.Nombre_Rol = 'Administrador'
				)
				AND NOT (
					?3 = 'Activo'
					AND EXISTS (SELECT 1 FROM Roles WHERE ID_Rol = ?2 AND Nombre_Rol = 'Administrador')
				)
				AND NOT EXISTS (
					SELECT 1 FROM Usuarios u JOIN Roles r ON r.ID_Rol = u.ID_Rol
					WHERE u.ID_Usuario <> ?1 AND u.Estado = 'Activo' AND r.Nombre_Rol = 'Administrador'
				) AS sin_admin;
		`,
		args: [idUsuario, idRolNuevo, estadoNuevo],
	});
	return Number(rows(rs)[0]?.sin_admin ?? 0) !== 0;
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

/**
 * El ID de trabajador a partir del de usuario, o null.
 *
 * Devolvia `number | null` y coercionaba el id con `Number(...) > 0`, pero `ID_Trabajador` es un
 * TEXT (un UUID): `Number("...")` daba NaN y la comparacion era siempre falsa, asi que en la Handy
 * esta consulta **no encontraba nunca a nadie**. Es el puente que usan el fichaje y la asignacion
 * de una comanda a su camarero. Resto de un tiempo en que los ids eran enteros.
 */
export async function idByUsuario(
	db: Client,
	idUsuario: string,
): Promise<string | null> {
	const rs = await db.execute({
		sql: `
			SELECT ID_Trabajador AS id
			FROM Trabajadores
			WHERE ID_Usuario = ?1
			LIMIT 1;
		`,
		args: [idUsuario],
	});
	const id = String(rows(rs)[0]?.id ?? "").trim();
	return id ? id : null;
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
				a.ID_Grupo AS ID_Grupo,
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
				ID_Grupo: null,
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

// RI-70: consulta de configuración para el gate nativo de la Handy; no autentica a la persona.
export async function permisosUsuario(db: Client, id: string): Promise<import("@tpv/contracts").AutorizacionUsuario | null> {
    const rs = await db.execute({sql:"SELECT r.Nombre_Rol, p.Permiso FROM Usuarios u JOIN Roles r ON r.ID_Rol=u.ID_Rol LEFT JOIN Roles_Permisos p ON p.ID_Rol=r.ID_Rol WHERE u.ID_Usuario=?1 AND u.Estado='Activo' ORDER BY p.Permiso",args:[id]});
    const filas = rows(rs);
    if (!filas.length) return null;
    return {rol:String(filas[0].Nombre_Rol),permisos:filas.filter((f) => f.Permiso != null).map((f) => String(f.Permiso))};
}
