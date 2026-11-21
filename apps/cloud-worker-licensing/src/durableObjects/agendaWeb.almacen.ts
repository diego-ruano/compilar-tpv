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
// verla en la base o al anularla. De una fallida queda sólo el correo, para avisar al cliente, hasta
// que se purga.

import type { Ocupacion } from "../domains/reservas_web/disponibilidad";
import { intervalo, sumarDias } from "../domains/reservas_web/disponibilidad";

/**
 * La versión del SQLite de la agenda. Una agenda recién creada nace con la última (`ESQUEMA`); a una
 * que ya existía, `migrar` le añade lo que le falte sin tocar lo que guarda.
 *
 *   1. Las tablas de la fase 2: peticiones, enlaces y estado.
 *   2. `peticiones.resultado` y `peticiones.codigo`: lo que contesta la Main (§5.4).
 *   3. `intentos`: lo que contestó cada alta del widget, por su `Idempotency-Key` (la crea `ESQUEMA`).
 *   4. `peticiones.aviso_ms`: el último intento del correo de una fallida que no salió.
 *   5. `altas_por_conexion`: el tope de altas por conexión (RW-ALTAS; la crea `ESQUEMA`).
 *   6. `enlaces.por_un_cambio`: el enlace llegó en el correo de un cambio del restaurante. Va en su
 *      propia versión porque hubo una 5 sólo con `altas_por_conexion`: una agenda que se quedó en
 *      ella no tiene la columna (RW-ALTAS).
 */
const VERSION_AGENDA = 6;

/** Lo que se queda una petición cerrada (vista, anulada o fallida) antes de borrarse. */
const RETENCION_CERRADAS_MS = 7 * 86_400_000;

/** Lo que se queda la respuesta de un intento: el widget lo repite en minutos, no en días. */
const RETENCION_INTENTOS_MS = 86_400_000;

/**
 * La ventana de los topes de altas, por negocio y por conexión: 24 h. Una conexión apuntada hace más
 * ya no cuenta, y la purga la borra (RW-ALTAS).
 */
export const VENTANA_TOPES_MS = 86_400_000;

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
	cerrada_ms?: number | null;
	resultado?: string | null;
	codigo?: string | null;
};

const ESQUEMA = [
	`CREATE TABLE IF NOT EXISTS estado (
		clave TEXT NOT NULL PRIMARY KEY,
		valor TEXT NOT NULL
	);`,
	// `cerrada_ms`: cuándo pasó a vista, anulada o fallida. De ahí cuenta la retención.
	// `resultado` y `codigo`: lo que contestó la Main al entregársela (§5.4).
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
		cerrada_ms   INTEGER,
		resultado    TEXT CHECK (resultado IS NULL OR resultado IN ('registrada', 'solapada', 'fallida')),
		codigo       TEXT,
		-- El último intento del correo de una fallida que no salió: las que no salen van detrás.
		aviso_ms     INTEGER
	);`,
	// Un alta y, como mucho, una cancelación por reserva.
	`CREATE UNIQUE INDEX IF NOT EXISTS ux_peticiones_tipo_reserva ON peticiones(tipo, id_reserva);`,
	`CREATE INDEX IF NOT EXISTS idx_peticiones_estado_dia ON peticiones(estado, dia_ymd);`,
	// `por_un_cambio`: 1 si el enlace llegó en el correo de un cambio del restaurante
	// (`enlaceParaUnCambio`), 0 si en la confirmación del alta (RW-ALTAS).
	`CREATE TABLE IF NOT EXISTS enlaces (
		token_hash    TEXT NOT NULL PRIMARY KEY,
		id_reserva    TEXT NOT NULL,
		caduca_ms     INTEGER NOT NULL,
		por_un_cambio INTEGER NOT NULL DEFAULT 0
	);`,
	`CREATE INDEX IF NOT EXISTS idx_enlaces_reserva ON enlaces(id_reserva);`,
	// Lo que contestó cada alta que acabó en reserva, por la clave del intento que manda el widget: si
	// se pierde la respuesta y lo repite, se contesta lo mismo en vez de dar otra reserva. Sin datos
	// personales: el código, el día, la hora, las personas y el número de mesa.
	`CREATE TABLE IF NOT EXISTS intentos (
		clave          TEXT NOT NULL PRIMARY KEY,
		respuesta_json TEXT NOT NULL,
		creado_ms      INTEGER NOT NULL
	);`,
	// RW-ALTAS · Una fila por alta apuntada y huella de la conexión desde la que llegó: la de la
	// conexión (la IP, o su /64 en IPv6) y, en IPv6, otra de su /48; los topes por conexión y por red.
	// Cuenta también las que su autor anula (no se borra al anular), que es lo que corta los ciclos de
	// reservar y cancelar. La IP no está en claro: cada huella es un HMAC, con un secreto del worker, de
	// la conexión o la red y del negocio (`puerta.ts::huellasDeLaConexion`), que no se deshace probando
	// IPs. Se borra en cuanto deja de contar, a las 24 h (`purgar`). No lleva el id de la reserva, que
	// no hace falta para contar; pero `creada_ms` es la misma marca que la de su petición, así que
	// mientras las dos están se puede cruzar qué alta llegó desde qué huella (no desde qué IP).
	`CREATE TABLE IF NOT EXISTS altas_por_conexion (
		conexion_hash TEXT NOT NULL,
		creada_ms     INTEGER NOT NULL
	);`,
	`CREATE INDEX IF NOT EXISTS idx_altas_por_conexion ON altas_por_conexion(conexion_hash, creada_ms);`,
];

/** Crea lo que falte y pone al día lo que ya había. Idempotente: se llama al construir el objeto. */
export function prepararAlmacen(sql: SqlStorage): void {
	for (const s of ESQUEMA) sql.exec(s);
	migrar(sql);
}

function migrar(sql: SqlStorage): void {
	const fila = sql.exec(`SELECT valor FROM estado WHERE clave = 'version';`).toArray()[0] as any;
	// Sin versión apuntada es una agenda que acaba de nacer con `ESQUEMA`: ya está al día.
	const version = fila ? Number(fila.valor) : VERSION_AGENDA;
	const columnas = new Set(
		sql.exec(`PRAGMA table_info(peticiones);`).toArray().map((c: any) => String(c.name)),
	);
	if (version < 2) {
		if (!columnas.has("resultado")) {
			sql.exec(
				`ALTER TABLE peticiones ADD COLUMN resultado TEXT
				 CHECK (resultado IS NULL OR resultado IN ('registrada', 'solapada', 'fallida'));`,
			);
		}
		if (!columnas.has("codigo")) sql.exec(`ALTER TABLE peticiones ADD COLUMN codigo TEXT;`);
	}
	if (version < 4 && !columnas.has("aviso_ms")) sql.exec(`ALTER TABLE peticiones ADD COLUMN aviso_ms INTEGER;`);
	if (version < 6) {
		const deLosEnlaces = new Set(sql.exec(`PRAGMA table_info(enlaces);`).toArray().map((c: any) => String(c.name)));
		// Los que ya había no se sabe por dónde llegaron: cuentan como de la confirmación.
		if (!deLosEnlaces.has("por_un_cambio")) {
			sql.exec(`ALTER TABLE enlaces ADD COLUMN por_un_cambio INTEGER NOT NULL DEFAULT 0;`);
		}
	}
	sql.exec(
		`INSERT INTO estado (clave, valor) VALUES ('version', ?)
		 ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor WHERE valor <> excluded.valor;`,
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
 * Las altas que ya están en la base pasan a `vista`: desde ahí las cuenta la base, y sus datos
 * personales sobran. Devuelve cuántas.
 */
export function darPorVistas(sql: SqlStorage, ids: Iterable<string>, ahoraMs: number): number {
	const lista = [...new Set(ids)];
	if (!lista.length) return 0;
	// Se cuentan las filas devueltas: `rowsWritten` suma también las entradas de los índices.
	return sql.exec(
		`UPDATE peticiones SET estado = 'vista', datos_json = NULL, cerrada_ms = ?
		 WHERE tipo = 'alta' AND estado IN ('pendiente', 'entregada')
		   AND id_reserva IN (SELECT value FROM json_each(?))
		 RETURNING id_peticion;`,
		ahoraMs,
		JSON.stringify(lista),
	).toArray().length;
}

/**
 * Con qué lectura de la base se decide. Las altas que esa lectura ya trae (`ids`) las cuenta la base;
 * las demás, la agenda.
 *
 * `vistasDesdeMs` cubre un cruce: mientras esta petición esperaba a la base, otra pudo leer una
 * versión más nueva, ver ya registrada un alta y darla por vista. Para esta lectura, más vieja, esa
 * alta no está en ningún sitio: ni en la base ni entre las pendientes. Por eso cuenta también la que
 * se dio por vista desde poco antes de empezar a leer y no viene en `ids`.
 */
export type Lectura = { ids: ReadonlySet<string>; vistasDesdeMs: number };

// Las altas que cuentan para una lectura: las que esperan y las vistas mientras se leía, menos las
// que la lectura ya trae. Un parámetro `?` para `vistasDesdeMs` y otro para los ids, en ese orden.
const ALTAS_PARA_LA_LECTURA = `tipo = 'alta'
	AND (estado IN ('pendiente', 'entregada') OR (estado = 'vista' AND cerrada_ms >= ?))
	AND id_reserva NOT IN (SELECT value FROM json_each(?))`;

/**
 * Lo que ocupan las altas que esta lectura de la base no trae, del día anterior al siguiente (la
 * misma ventana que `lecturas.ts::ocupacionAlrededorDe`). Con la duración de ahora del negocio,
 * que es la que tendrán en la base: la Main las registra sin duración propia.
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

/** Por dónde va la alarma recorriendo lo que espera de un tipo: la última petición que miró. */
export type CursorAlarma = { creada_ms: number; id_reserva: string };

type TipoPeticion = FilaPeticion["tipo"];

/**
 * Lo que espera a verse en la base, de un tipo, de lo más viejo a lo más nuevo y a partir de
 * `despues` (sin incluirlo): lo que mira la alarma, por lotes. Un alta espera a que la reserva
 * aparezca; una cancelación, a que aparezca cancelada.
 */
export function esperando(
	sql: SqlStorage,
	tipo: TipoPeticion,
	max: number,
	despues: CursorAlarma | null,
): CursorAlarma[] {
	const desde = despues ?? { creada_ms: -1, id_reserva: "" };
	return (
		sql
			.exec(
				`SELECT creada_ms, id_reserva FROM peticiones
				 WHERE tipo = ? AND estado IN ('pendiente', 'entregada') AND (creada_ms, id_reserva) > (?, ?)
				 ORDER BY creada_ms, id_reserva LIMIT ?;`,
				tipo,
				desde.creada_ms,
				desde.id_reserva,
				max,
			)
			.toArray() as any[]
	).map((f) => ({ creada_ms: Number(f.creada_ms), id_reserva: String(f.id_reserva) }));
}

export function cursorDeLaAlarma(sql: SqlStorage, tipo: TipoPeticion): CursorAlarma | null {
	const fila = sql.exec(`SELECT valor FROM estado WHERE clave = ?;`, `cursor_${tipo}`).toArray()[0] as any;
	return fila ? (JSON.parse(String(fila.valor)) as CursorAlarma) : null;
}

/** `null` vuelve a empezar por lo más viejo. */
export function guardarCursorDeLaAlarma(sql: SqlStorage, tipo: TipoPeticion, cursor: CursorAlarma | null): void {
	if (cursor) {
		sql.exec(
			`INSERT INTO estado (clave, valor) VALUES (?, ?)
			 ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor;`,
			`cursor_${tipo}`,
			JSON.stringify(cursor),
		);
	} else {
		sql.exec(`DELETE FROM estado WHERE clave = ?;`, `cursor_${tipo}`);
	}
}

/**
 * Las cancelaciones cuya reserva ya está cancelada (o terminada) en la base están hechas: pasan a
 * `vista`. Antes no: que la Main diga que la ha cancelado no basta, porque hasta que su outbox sube
 * la cancelación sólo existe en su base. Devuelve cuántas.
 */
export function cancelacionesHechas(sql: SqlStorage, ids: Iterable<string>, ahoraMs: number): number {
	const lista = [...new Set(ids)];
	if (!lista.length) return 0;
	return sql
		.exec(
			`UPDATE peticiones SET estado = 'vista', cerrada_ms = ?
			 WHERE tipo = 'cancelacion' AND estado IN ('pendiente', 'entregada')
			   AND id_reserva IN (SELECT value FROM json_each(?))
			 RETURNING id_peticion;`,
			ahoraMs,
			JSON.stringify(lista),
		)
		.toArray().length;
}

/**
 * Altas apuntadas desde `desdeMs`: el tope por negocio. Cuentan todas menos las que su autor anuló
 * antes de que la Main las tuviera (AUD-38): ésas no llegan al TPV ni ocupan mesa, y contarlas dejaba
 * a cualquiera agotar el tope del día reservando y cancelando. Lo que la Main tiene o tendrá
 * (pendiente, entregada, vista, fallida) sigue contando aunque luego se cancele en el TPV.
 */
export function altasDesde(sql: SqlStorage, desdeMs: number): number {
	const fila = sql
		.exec(`SELECT COUNT(*) AS n FROM peticiones WHERE tipo = 'alta' AND estado <> 'anulada' AND creada_ms >= ?;`, desdeMs)
		.toArray()[0] as any;
	return Number(fila?.n ?? 0);
}

/**
 * RW-ALTAS · Altas apuntadas desde una conexión desde `desdeMs`: el tope por conexión. Todas,
 * también las anuladas por su autor: lo que se corta aquí es reservar y cancelar en bucle.
 */
export function altasDeLaConexionDesde(sql: SqlStorage, conexionHash: string, desdeMs: number): number {
	const fila = sql
		.exec(
			`SELECT COUNT(*) AS n FROM altas_por_conexion WHERE conexion_hash = ? AND creada_ms >= ?;`,
			conexionHash,
			desdeMs,
		)
		.toArray()[0] as any;
	return Number(fila?.n ?? 0);
}

/** RW-ALTAS · Apunta un alta de esa conexión. Va en la misma transacción que `apuntarAlta`. */
export function apuntarAltaDeLaConexion(sql: SqlStorage, conexionHash: string, creadaMs: number): void {
	sql.exec(`INSERT INTO altas_por_conexion (conexion_hash, creada_ms) VALUES (?, ?);`, conexionHash, creadaMs);
}

/**
 * Las altas vivas de un correo desde `hoy` que la lectura de la base no trae (las que sí, las cuenta
 * la base; ver `Lectura`). Una con cancelación pedida ya no cuenta.
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

/** Lo que se contesta de un alta que ha acabado en reserva. */
export type RespuestaDelAlta = {
	id_reserva: string;
	codigo: string;
	dia: string;
	hora: string;
	personas: number;
	id_mesa: string;
	/** El nombre de la mesa en la Main. */
	mesa: string;
};

/** Lo que contestó el intento de alta con esa clave, si acabó en reserva y no ha caducado. */
export function respuestaDelIntento(sql: SqlStorage, clave: string, ahoraMs: number): RespuestaDelAlta | null {
	const fila = sql
		.exec(`SELECT respuesta_json FROM intentos WHERE clave = ? AND creado_ms > ?;`, clave, ahoraMs - RETENCION_INTENTOS_MS)
		.toArray()[0] as any;
	return fila ? (JSON.parse(String(fila.respuesta_json)) as RespuestaDelAlta) : null;
}

/**
 * Apunta lo que contesta un intento de alta. Va en la misma transacción que `apuntarAlta`, y quien
 * llama ya ha mirado que esa clave no tiene una respuesta viva: si la fila existe, es una caducada que
 * la purga aún no ha borrado, y se pisa.
 */
export function apuntarIntento(sql: SqlStorage, clave: string, respuesta: RespuestaDelAlta, ahoraMs: number): void {
	sql.exec(
		`INSERT INTO intentos (clave, respuesta_json, creado_ms) VALUES (?, ?, ?)
		 ON CONFLICT(clave) DO UPDATE SET respuesta_json = excluded.respuesta_json, creado_ms = excluded.creado_ms;`,
		clave,
		JSON.stringify(respuesta),
		ahoraMs,
	);
}

/**
 * Que los enlaces de cancelar de una reserva valgan, al menos, hasta `caducaMs`: el restaurante la ha
 * movido y el correo que se lo cuenta remite al enlace de la confirmación. Nunca los acorta.
 */
export function prolongarEnlaces(sql: SqlStorage, idReserva: string, caducaMs: number): void {
	sql.exec(`UPDATE enlaces SET caduca_ms = MAX(caduca_ms, ?) WHERE id_reserva = ?;`, caducaMs, idReserva);
}

/** Un enlace de cancelar más para una reserva: el del correo de un cambio del restaurante. */
export function apuntarEnlace(sql: SqlStorage, idReserva: string, tokenHash: string, caducaMs: number): void {
	sql.exec(
		`INSERT INTO enlaces (token_hash, id_reserva, caduca_ms, por_un_cambio) VALUES (?, ?, ?, 1);`,
		tokenHash,
		idReserva,
		caducaMs,
	);
}

/** Un enlace de cancelar vivo: su reserva y si llegó en el correo de un cambio del restaurante. */
export type EnlaceVivo = { id_reserva: string; por_un_cambio: boolean };

/** El enlace de cancelar de ese hash, si existe y no ha caducado. */
export function reservaDelEnlace(sql: SqlStorage, tokenHash: string, ahoraMs: number): EnlaceVivo | null {
	const fila = sql
		.exec(`SELECT id_reserva, por_un_cambio FROM enlaces WHERE token_hash = ? AND caduca_ms > ?;`, tokenHash, ahoraMs)
		.toArray()[0] as any;
	return fila ? { id_reserva: String(fila.id_reserva), por_un_cambio: Number(fila.por_un_cambio) === 1 } : null;
}

export function peticion(sql: SqlStorage, tipo: "alta" | "cancelacion", idReserva: string): FilaPeticion | null {
	const fila = sql
		.exec(`SELECT * FROM peticiones WHERE tipo = ? AND id_reserva = ?;`, tipo, idReserva)
		.toArray()[0] as any;
	return fila ? conTipos(fila) : null;
}

/**
 * Un alta que la Main todavía no tiene se anula aquí mismo: deja libre la mesa y olvida los datos.
 * Sólo si **nunca** se le entregó (`intentos = 0`): una que vuelve a estar `pendiente` porque se le
 * vuelve a ofrecer puede estar ya en la Main, esperando en su outbox, y anularla aquí la dejaría
 * viva allí. Ésa necesita una cancelación.
 */
export function anularAlta(sql: SqlStorage, idReserva: string, ahoraMs: number): boolean {
	return (
		sql.exec(
			`UPDATE peticiones SET estado = 'anulada', datos_json = NULL, cerrada_ms = ?
			 WHERE tipo = 'alta' AND id_reserva = ? AND estado = 'pendiente' AND intentos = 0;`,
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
 * La limpieza de la alarma: las peticiones cerradas hace más de una semana, los enlaces caducados,
 * las respuestas de los intentos de más de un día y las conexiones que ya no cuentan para su tope
 * (RW-ALTAS).
 * Devuelve si queda algo por lo que volver a despertar.
 */
export function purgar(sql: SqlStorage, ahoraMs: number): boolean {
	sql.exec(
		`DELETE FROM peticiones WHERE estado IN ('vista', 'fallida', 'anulada') AND cerrada_ms < ?;`,
		ahoraMs - RETENCION_CERRADAS_MS,
	);
	sql.exec(`DELETE FROM enlaces WHERE caduca_ms <= ?;`, ahoraMs);
	sql.exec(`DELETE FROM intentos WHERE creado_ms <= ?;`, ahoraMs - RETENCION_INTENTOS_MS);
	sql.exec(`DELETE FROM altas_por_conexion WHERE creada_ms < ?;`, ahoraMs - VENTANA_TOPES_MS);
	const quedan = sql
		.exec(
			`SELECT (SELECT COUNT(*) FROM peticiones) + (SELECT COUNT(*) FROM enlaces) + (SELECT COUNT(*) FROM intentos)
			      + (SELECT COUNT(*) FROM altas_por_conexion) AS n;`,
		)
		.toArray()[0] as any;
	return Number(quedan?.n ?? 0) > 0;
}

// ── La entrega a la Main (§5.4) ─────────────────────────────────────────────────────────────────

function conTipos(f: any): FilaPeticion {
	return {
		...f,
		comensales: Number(f.comensales),
		creada_ms: Number(f.creada_ms),
		cerrada_ms: f.cerrada_ms === null ? null : Number(f.cerrada_ms),
	} as FilaPeticion;
}

/**
 * Las peticiones `pendiente` para la Main, por orden de llegada (un alta siempre antes que su
 * cancelación), que pasan a `entregada`. Como mucho `max` pendientes, más las altas que acompañan
 * a sus cancelaciones; `hayMas` dice si quedan.
 */
export function entregarPendientes(
	sql: SqlStorage,
	max: number,
	ahoraMs: number,
): { peticiones: FilaPeticion[]; hayMas: boolean } {
	const filas = (
		sql
			.exec(`SELECT * FROM peticiones WHERE estado = 'pendiente' ORDER BY creada_ms, id_peticion LIMIT ?;`, max + 1)
			.toArray() as any[]
	).map(conTipos);
	const tanda = filas.slice(0, max);
	// Una cancelación lleva delante su alta si todavía no se ha visto en la base. Si la respuesta con el
	// alta se perdió por el camino, la Main no la tiene: le llegaría sólo la cancelación, diría que esa
	// reserva no existe, y al volver a ofrecerle el alta la registraría viva. Juntas, el alta se
	// registra (o ya estaba) y en seguida se cancela.
	const entregar: FilaPeticion[] = [];
	const enLaTanda = new Set(tanda.map((f) => f.id_peticion));
	for (const f of tanda) {
		if (f.tipo === "cancelacion") {
			const suAlta = sql
				.exec(`SELECT * FROM peticiones WHERE tipo = 'alta' AND id_reserva = ? AND estado = 'entregada';`, f.id_reserva)
				.toArray()[0];
			if (suAlta && !enLaTanda.has(String((suAlta as any).id_peticion))) entregar.push(conTipos(suAlta));
		}
		entregar.push(f);
	}
	if (entregar.length) {
		sql.exec(
			`UPDATE peticiones SET estado = 'entregada', entregada_ms = ?, intentos = intentos + 1
			 WHERE id_peticion IN (SELECT value FROM json_each(?));`,
			ahoraMs,
			JSON.stringify(entregar.map((f) => f.id_peticion)),
		);
	}
	return { peticiones: entregar, hayMas: filas.length > max };
}

export type ResultadoDeLaMain = {
	id_peticion: string;
	resultado: "registrada" | "solapada" | "fallida";
	codigo: string | null;
};

/**
 * Lo que la Main contesta de lo que se le entregó. Sólo cuenta para lo que está `entregada`: una
 * respuesta repetida, tardía o de algo que no existe no cambia nada.
 *
 *   · Lo registrado (o solapado) sigue `entregada` hasta verse en la base: un alta, al aparecer la
 *     reserva; una cancelación, al aparecer cancelada. Si no, se vuelve a ofrecer. La palabra de la
 *     Main no basta: hasta que su outbox lo sube, sólo existe en su base.
 *   · Lo `fallida` se cierra. De un alta queda sólo el correo, para avisar al cliente.
 *
 * Devuelve cuántas ha apuntado y las altas fallidas.
 */
export function apuntarResultados(
	sql: SqlStorage,
	resultados: ResultadoDeLaMain[],
	ahoraMs: number,
): { apuntadas: number; fallidas: FilaPeticion[] } {
	let apuntadas = 0;
	const fallidas: FilaPeticion[] = [];
	for (const r of resultados) {
		const crudo = sql
			.exec(`SELECT * FROM peticiones WHERE id_peticion = ? AND estado = 'entregada';`, r.id_peticion)
			.toArray()[0];
		if (!crudo) continue;
		const fila = conTipos(crudo);
		if (r.resultado === "fallida") {
			sql.exec(
				`UPDATE peticiones
				 SET estado = 'fallida', cerrada_ms = ?, resultado = 'fallida', codigo = ?,
				     datos_json = CASE WHEN datos_json IS NULL THEN NULL
				                       ELSE json_object('email', json_extract(datos_json, '$.email')) END
				 WHERE id_peticion = ?;`,
				ahoraMs,
				r.codigo,
				r.id_peticion,
			);
			if (fila.tipo === "alta") fallidas.push({ ...fila, codigo: r.codigo });
		} else {
			sql.exec(`UPDATE peticiones SET resultado = ? WHERE id_peticion = ?;`, r.resultado, r.id_peticion);
		}
		apuntadas++;
	}
	return { apuntadas, fallidas };
}

/**
 * Las altas que la Main no pudo registrar y aún guardan el correo: falta decírselo al cliente
 * (§4.8). Primero las que no se han intentado, y de ellas las más viejas; las que se intentaron sin
 * éxito, detrás, de la que lleva más sin intentarse a la última: ninguna tapa a las demás. Como
 * mucho `max`.
 */
export function fallidasPorAvisar(sql: SqlStorage, max: number): FilaPeticion[] {
	return (
		sql
			.exec(
				`SELECT * FROM peticiones WHERE tipo = 'alta' AND estado = 'fallida' AND datos_json IS NOT NULL
				 ORDER BY COALESCE(aviso_ms, 0), creada_ms, id_peticion LIMIT ?;`,
				max,
			)
			.toArray() as any[]
	).map(conTipos);
}

/** Un correo de una fallida que no ha salido: va detrás de las que aún no se han intentado. */
export function apuntarIntentoDeAviso(sql: SqlStorage, idPeticion: string, ahoraMs: number): void {
	sql.exec(`UPDATE peticiones SET aviso_ms = ? WHERE id_peticion = ?;`, ahoraMs, idPeticion);
}

/** Ya se le dijo al cliente, o ya no sirve de nada decírselo: la agenda olvida su correo. */
export function olvidarCorreo(sql: SqlStorage, idPeticion: string): void {
	sql.exec(`UPDATE peticiones SET datos_json = NULL WHERE id_peticion = ?;`, idPeticion);
}

/**
 * Lo entregado hace más de una hora que no se ha visto en la base (un alta) o del que la Main no ha
 * contestado (una cancelación) vuelve a `pendiente`. Cubre una Main que perdió su base o un outbox
 * atascado: registrarla otra vez no la duplica (el `INSERT` es idempotente por `ID_Reserva`).
 * Devuelve cuántas.
 */
export function reofrecer(sql: SqlStorage, entregadasAntesDeMs: number): number {
	return sql.exec(
		`UPDATE peticiones SET estado = 'pendiente' WHERE estado = 'entregada' AND entregada_ms < ?
		 RETURNING id_peticion;`,
		entregadasAntesDeMs,
	).toArray().length;
}

/** Las que siguen `pendiente` desde antes de `antesDeMs`: la Main lleva tiempo sin recogerlas. */
export function pendientesDesde(sql: SqlStorage, antesDeMs: number): number {
	const fila = sql
		.exec(`SELECT COUNT(*) AS n FROM peticiones WHERE estado = 'pendiente' AND creada_ms < ?;`, antesDeMs)
		.toArray()[0] as any;
	return Number(fila?.n ?? 0);
}
