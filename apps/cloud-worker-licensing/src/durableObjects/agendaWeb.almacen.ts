// src/durableObjects/agendaWeb.almacen.ts
//
// El SQLite propio de la agenda de reservas web (docs/estudios/reservas-web.md §3.3). No es una
// base de tenant ni pasa por las migraciones: lo crea la agenda con su número de versión.
//
// Todo aquí es SÍNCRONO a propósito. La agenda reparte mesas comprobando y apuntando en el mismo
// bloque, sin un `await` en medio (§4.3, «Reservar»): mientras corre código síncrono el Durable
// Object no atiende otra petición, así que dos altas a la vez para la misma mesa no pueden pasar
// las dos la comprobación.
//
// Los datos personales (`datos_json`) sólo están mientras la reserva espera a la Main: se borran al
// verla en Turso, al anularla o al fallar.

import type { Ocupacion } from "../domains/reservas_web/disponibilidad";
import { intervalo, sumarDias } from "../domains/reservas_web/disponibilidad";

const VERSION_AGENDA = 1;

/** Lo que se queda una petición cerrada (vista, anulada o fallida) antes de borrarse. */
const RETENCION_CERRADAS_MS = 7 * 86_400_000;

type EstadoPeticion = "pendiente" | "entregada" | "vista" | "fallida" | "anulada";

export type FilaPeticion = {
	id_peticion: string;
	tipo: "alta" | "cancelacion";
	id_reserva: string;
	id_mesa: string | null;
	dia_ymd: string;
	hora: string;
	comensales: number;
	email_hash: string | null;
	datos_json: string | null;
	creada_local: string;
	creada_ms: number;
	estado: EstadoPeticion;
};

const ESQUEMA = [
	`CREATE TABLE IF NOT EXISTS estado (
		clave TEXT NOT NULL PRIMARY KEY,
		valor TEXT NOT NULL
	);`,
	// `cerrada_ms`: cuándo pasó a vista, anulada o fallida. De ahí cuenta la retención.
	`CREATE TABLE IF NOT EXISTS peticiones (
		id_peticion  TEXT NOT NULL PRIMARY KEY,
		tipo         TEXT NOT NULL CHECK (tipo IN ('alta', 'cancelacion')),
		id_reserva   TEXT NOT NULL,
		id_mesa      TEXT,
		dia_ymd      TEXT NOT NULL,
		hora         TEXT NOT NULL,
		comensales   INTEGER NOT NULL,
		email_hash   TEXT,
		datos_json   TEXT,
		creada_local TEXT NOT NULL,
		creada_ms    INTEGER NOT NULL,
		estado       TEXT NOT NULL CHECK (estado IN ('pendiente', 'entregada', 'vista', 'fallida', 'anulada')),
		entregada_ms INTEGER,
		intentos     INTEGER NOT NULL DEFAULT 0,
		cerrada_ms   INTEGER
	);`,
	// Un alta y, como mucho, una cancelación por reserva.
	`CREATE UNIQUE INDEX IF NOT EXISTS ux_peticiones_tipo_reserva ON peticiones(tipo, id_reserva);`,
	`CREATE INDEX IF NOT EXISTS idx_peticiones_estado_dia ON peticiones(estado, dia_ymd);`,
	`CREATE TABLE IF NOT EXISTS enlaces (
		token_hash TEXT NOT NULL PRIMARY KEY,
		id_reserva TEXT NOT NULL,
		caduca_ms  INTEGER NOT NULL
	);`,
	`CREATE INDEX IF NOT EXISTS idx_enlaces_reserva ON enlaces(id_reserva);`,
];

/** Crea lo que falte. Idempotente: se llama al construir el Durable Object. */
export function prepararAlmacen(sql: SqlStorage): void {
	for (const s of ESQUEMA) sql.exec(s);
	sql.exec(
		`INSERT INTO estado (clave, valor) VALUES ('version', ?) ON CONFLICT(clave) DO NOTHING;`,
		String(VERSION_AGENDA),
	);
}

/**
 * El negocio de esta agenda. Se apunta en cada llamada (el nombre del Durable Object no se puede
 * leer desde dentro) para que la alarma sepa de quién es sin que nadie se lo diga.
 */
export function recordarNegocio(sql: SqlStorage, tenantId: string): void {
	sql.exec(
		`INSERT INTO estado (clave, valor) VALUES ('tenant_id', ?)
		 ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor WHERE valor <> excluded.valor;`,
		tenantId,
	);
}

export function negocioRecordado(sql: SqlStorage): string | null {
	const fila = sql.exec(`SELECT valor FROM estado WHERE clave = 'tenant_id';`).toArray()[0] as any;
	return fila ? String(fila.valor) : null;
}

/**
 * Las altas que ya están en Turso pasan a `vista`: desde ahí las cuenta Turso, y sus datos
 * personales sobran. Devuelve cuántas.
 */
export function darPorVistas(sql: SqlStorage, ids: Iterable<string>, ahoraMs: number): number {
	const lista = [...new Set(ids)];
	if (!lista.length) return 0;
	return sql.exec(
		`UPDATE peticiones SET estado = 'vista', datos_json = NULL, cerrada_ms = ?
		 WHERE tipo = 'alta' AND estado IN ('pendiente', 'entregada')
		   AND id_reserva IN (SELECT value FROM json_each(?));`,
		ahoraMs,
		JSON.stringify(lista),
	).rowsWritten;
}

/**
 * Con qué lectura de Turso se decide. Las altas que esa lectura ya trae (`ids`) las cuenta Turso;
 * las demás, la agenda.
 *
 * `vistasDesdeMs` cubre un cruce: mientras esta petición esperaba a Turso, otra pudo leer una
 * versión más nueva, ver ya registrada un alta y darla por vista. Para esta lectura, más vieja, esa
 * alta no está en ningún sitio: ni en Turso ni entre las pendientes. Por eso cuenta también la que
 * se dio por vista desde poco antes de empezar a leer y no viene en `ids`.
 */
export type Lectura = { ids: ReadonlySet<string>; vistasDesdeMs: number };

// Las altas que cuentan para una lectura: las que esperan y las vistas mientras se leía, menos las
// que la lectura ya trae. Un parámetro `?` para `vistasDesdeMs` y otro para los ids, en ese orden.
const ALTAS_PARA_LA_LECTURA = `tipo = 'alta'
	AND (estado IN ('pendiente', 'entregada') OR (estado = 'vista' AND cerrada_ms >= ?))
	AND id_reserva NOT IN (SELECT value FROM json_each(?))`;

/**
 * Lo que ocupan las altas que esta lectura de Turso no trae, del día anterior al siguiente (la
 * misma ventana que `lecturas.ts::ocupacionAlrededorDe`). Con la duración de ahora del negocio,
 * que es la que tendrán en Turso: la Main las registra sin duración propia.
 */
export function ocupacionPendiente(sql: SqlStorage, dia: string, duracion: number, lectura: Lectura): Ocupacion[] {
	const filas = sql
		.exec(
			`SELECT id_mesa, dia_ymd, hora FROM peticiones
			 WHERE ${ALTAS_PARA_LA_LECTURA} AND id_mesa IS NOT NULL AND dia_ymd >= ? AND dia_ymd <= ?;`,
			lectura.vistasDesdeMs,
			JSON.stringify([...lectura.ids]),
			sumarDias(dia, -1),
			sumarDias(dia, 1),
		)
		.toArray() as any[];
	return filas.map((f) => ({ id_mesa: String(f.id_mesa), ...intervalo(String(f.dia_ymd), String(f.hora), duracion) }));
}

/** Altas apuntadas desde `desdeMs`, en cualquier estado: el tope por negocio. */
export function altasDesde(sql: SqlStorage, desdeMs: number): number {
	const fila = sql
		.exec(`SELECT COUNT(*) AS n FROM peticiones WHERE tipo = 'alta' AND creada_ms >= ?;`, desdeMs)
		.toArray()[0] as any;
	return Number(fila?.n ?? 0);
}

/**
 * Las altas vivas de un correo desde `hoy` que la lectura de Turso no trae (las que sí, las cuenta
 * Turso; ver `Lectura`). Una con cancelación pedida ya no cuenta.
 */
export function vivasDelCorreoEnLaAgenda(sql: SqlStorage, emailHash: string, hoy: string, lectura: Lectura): number {
	const fila = sql
		.exec(
			`SELECT COUNT(*) AS n FROM peticiones A
			 WHERE ${ALTAS_PARA_LA_LECTURA} AND A.email_hash = ? AND A.dia_ymd >= ?
			   AND NOT EXISTS (SELECT 1 FROM peticiones C WHERE C.tipo = 'cancelacion' AND C.id_reserva = A.id_reserva);`,
			lectura.vistasDesdeMs,
			JSON.stringify([...lectura.ids]),
			emailHash,
			hoy,
		)
		.toArray()[0] as any;
	return Number(fila?.n ?? 0);
}

/** Apunta un alta y su enlace de cancelar. Quien llama lo envuelve en `transactionSync`. */
export function apuntarAlta(sql: SqlStorage, p: FilaPeticion, enlace: { tokenHash: string; caducaMs: number }): void {
	sql.exec(
		`INSERT INTO peticiones (id_peticion, tipo, id_reserva, id_mesa, dia_ymd, hora, comensales, email_hash,
		                         datos_json, creada_local, creada_ms, estado)
		 VALUES (?, 'alta', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente');`,
		p.id_peticion,
		p.id_reserva,
		p.id_mesa,
		p.dia_ymd,
		p.hora,
		p.comensales,
		p.email_hash,
		p.datos_json,
		p.creada_local,
		p.creada_ms,
	);
	sql.exec(
		`INSERT INTO enlaces (token_hash, id_reserva, caduca_ms) VALUES (?, ?, ?);`,
		enlace.tokenHash,
		p.id_reserva,
		enlace.caducaMs,
	);
}

/** La reserva de un enlace de cancelar, si existe y no ha caducado. */
export function reservaDelEnlace(sql: SqlStorage, tokenHash: string, ahoraMs: number): string | null {
	const fila = sql
		.exec(`SELECT id_reserva FROM enlaces WHERE token_hash = ? AND caduca_ms > ?;`, tokenHash, ahoraMs)
		.toArray()[0] as any;
	return fila ? String(fila.id_reserva) : null;
}

export function peticion(sql: SqlStorage, tipo: "alta" | "cancelacion", idReserva: string): FilaPeticion | null {
	const fila = sql
		.exec(`SELECT * FROM peticiones WHERE tipo = ? AND id_reserva = ?;`, tipo, idReserva)
		.toArray()[0] as any;
	return fila ? ({ ...fila, comensales: Number(fila.comensales), creada_ms: Number(fila.creada_ms) } as FilaPeticion) : null;
}

/** Un alta que la Main todavía no tiene se anula aquí mismo: deja libre la mesa y olvida los datos. */
export function anularAlta(sql: SqlStorage, idReserva: string, ahoraMs: number): boolean {
	return (
		sql.exec(
			`UPDATE peticiones SET estado = 'anulada', datos_json = NULL, cerrada_ms = ?
			 WHERE tipo = 'alta' AND id_reserva = ? AND estado = 'pendiente';`,
			ahoraMs,
			idReserva,
		).rowsWritten > 0
	);
}

/**
 * Una cancelación para la Main, que ya tiene el alta (o la tendrá: se le entrega detrás). Idempotente
 * por reserva: pedirla dos veces deja una.
 */
export function apuntarCancelacion(
	sql: SqlStorage,
	p: { id_peticion: string; id_reserva: string; id_mesa: string | null; dia_ymd: string; hora: string; comensales: number; creada_local: string; creada_ms: number },
): void {
	sql.exec(
		`INSERT INTO peticiones (id_peticion, tipo, id_reserva, id_mesa, dia_ymd, hora, comensales,
		                         creada_local, creada_ms, estado)
		 VALUES (?, 'cancelacion', ?, ?, ?, ?, ?, ?, ?, 'pendiente')
		 ON CONFLICT(tipo, id_reserva) DO NOTHING;`,
		p.id_peticion,
		p.id_reserva,
		p.id_mesa,
		p.dia_ymd,
		p.hora,
		p.comensales,
		p.creada_local,
		p.creada_ms,
	);
}

/**
 * La limpieza de la alarma: las peticiones cerradas hace más de una semana y los enlaces caducados.
 * Devuelve si queda algo por lo que volver a despertar.
 */
export function purgar(sql: SqlStorage, ahoraMs: number): boolean {
	sql.exec(
		`DELETE FROM peticiones WHERE estado IN ('vista', 'fallida', 'anulada') AND cerrada_ms < ?;`,
		ahoraMs - RETENCION_CERRADAS_MS,
	);
	sql.exec(`DELETE FROM enlaces WHERE caduca_ms <= ?;`, ahoraMs);
	const quedan = sql
		.exec(`SELECT (SELECT COUNT(*) FROM peticiones) + (SELECT COUNT(*) FROM enlaces) AS n;`)
		.toArray()[0] as any;
	return Number(quedan?.n ?? 0) > 0;
}
