// src/durableObjects/tenantHub.sqlite.ts
//
// La base del negocio vive en el SQLite del propio TenantHub.
//
// El motor, las rutas y los tests hablan con la base a través de un `Client` de libsql (`execute`,
// `batch`). Aquí se sirve esa misma forma sobre `ctx.storage.sql`, para que las doscientas
// consultas del worker no dependan de dónde vive la base: es `clienteLocal`, que usan las rutas
// (que se ejecutan dentro del DO, `lib/enElHub.ts`) y el motor. Desde fuera del DO no se lee por
// aquí: la agenda y la API pública de la reserva piden una lectura entera
// (`domains/reservas_web/lecturasDeLaWeb.ts`).
//
// Diferencias con el SQLite de libsql que este fichero absorbe:
//
// - `rowsWritten` del cursor cuenta también las filas de índice, así que NO es el `rowsAffected` de
//   libsql. Se pregunta a SQLite con `changes()`, que es lo mismo que devuelve libsql.
// - No hay `lastInsertRowid`: se pregunta con `last_insert_rowid()` tras un INSERT.
// - Una clave foránea aplazada (`defer_foreign_keys`) que sigue rota al confirmar no lanza: el
//   runtime **resetea el Durable Object entero** a su último estado bueno (comprobado en
//   `test/sondaSqliteDo.test.ts`). Ver `loteEnBruto`.
// - `BEGIN`/`SAVEPOINT` no están permitidos: la atomicidad del lote la da `transactionSync`.

import type { Client, ResultSet } from "@libsql/client/web";

import { MIGRATIONS, normalize, sha256Hex } from "../server/tenantMigrations";
import { HubError } from "../lib/errorHttp";
import type { Guarda } from "./tenantHub.types";
import { operacionDemasiadoGrande, type TopeDeOperacion } from "./tenantHub.presupuesto";

/**
 * Una sentencia tal y como la acepta libsql: texto suelto, o texto con argumentos posicionales. En un
 * lote (`loteEnBruto`) puede llevar además la `guarda` de un paso `guard` (SYNC-30).
 */
type Sentencia = string | { sql: string; args?: unknown[]; guarda?: Guarda };

/** Las filas de una sentencia en bruto: columnas y valores, sin el envoltorio de libsql. */
export type FilasEnBruto = {
	columns: string[];
	rows: unknown[][];
	rowsAffected: number;
	lastInsertRowid: number | null;
	/** AUD-36: las filas que ha escrito la sentencia, con las de sus índices y triggers (`rowsWritten`). */
	filasEscritas?: number;
};

const VACIO: FilasEnBruto = { columns: [], rows: [], rowsAffected: 0, lastInsertRowid: null };

const APLAZAR_FK = /^\s*PRAGMA\s+defer_foreign_keys\s*=\s*(ON|1|TRUE|YES)\s*;?\s*$/i;
const PRIMERA_PALABRA = /^\s*(\w+)/;

function partes(s: Sentencia): { texto: string; args: unknown[] } {
	if (typeof s === "string") return { texto: s, args: [] };
	const args = s.args ?? [];
	if (!Array.isArray(args)) {
		// Ninguna consulta del negocio usa argumentos con nombre. Si llega una, que se vea aquí y no
		// como un `?1` sin valor.
		throw new Error("tenantHub.sqlite: los argumentos con nombre no están soportados");
	}
	return { texto: s.sql, args };
}

/** Los valores que acepta `sql.exec`: libsql admite además booleanos y `undefined`. */
function valorParaExec(v: unknown): unknown {
	if (v === undefined) return null;
	if (typeof v === "boolean") return v ? 1 : 0;
	if (typeof v === "bigint") return Number(v);
	return v;
}

/** Ejecuta una sentencia y devuelve sus filas en bruto, con `rowsAffected` como el de libsql. */
export function ejecutarEnBruto(sql: SqlStorage, s: Sentencia): FilasEnBruto {
	const { texto, args } = partes(s);
	if (APLAZAR_FK.test(texto)) {
		// Fuera de un lote no hay transacción que la acote: el aplazamiento seguiría vivo hasta el
		// commit implícito del evento y una FK rota reseteará el DO. Sólo `loteEnBruto` la honra.
		return VACIO;
	}
	const cursor = sql.exec(texto, ...args.map(valorParaExec));
	const columns = [...cursor.columnNames];
	const rows = Array.from(cursor.raw()) as unknown[][];

	const verbo = (PRIMERA_PALABRA.exec(texto)?.[1] ?? "").toUpperCase();
	const esEscritura =
		verbo === "INSERT" || verbo === "UPDATE" || verbo === "DELETE" || verbo === "REPLACE";
	let rowsAffected = 0;
	let lastInsertRowid: number | null = null;
	if (esEscritura || (verbo === "WITH" && cursor.rowsWritten > 0)) {
		const r = sql.exec("SELECT changes() AS c, last_insert_rowid() AS r;").one() as {
			c: number;
			r: number;
		};
		rowsAffected = Number(r.c);
		if (verbo === "INSERT" || verbo === "REPLACE" || verbo === "WITH") lastInsertRowid = Number(r.r);
	}
	return { columns, rows, rowsAffected, lastInsertRowid, filasEscritas: cursor.rowsWritten };
}

function esFkRota(e: unknown): boolean {
	return /FOREIGN KEY constraint failed/i.test(String((e as Error)?.message ?? e));
}

/**
 * Un lote todo-o-nada, como `batch()` de libsql.
 *
 * La Main confirma cada transacción con `defer_foreign_keys` (db.rs), así que sus operaciones pueden
 * escribir una hija antes que su padre, y el motor manda ese mismo PRAGMA al aplicarlas. Aquí no se
 * puede dejar que una FK aplazada llegue rota al commit, porque el runtime resetea el DO en vez de
 * lanzar. Así que:
 *
 * 1. Primero se prueba SIN aplazar. Si entra, el resultado es el mismo que aplazando (aplazar sólo
 *    cambia CUÁNDO se comprueba) y no cuesta nada más.
 * 2. Si falla por una FK, se repite como lo hizo la Main, aplazando, y antes de cerrar se mira
 *    `PRAGMA foreign_key_check`. Si queda alguna rota se lanza un error normal: la transacción se
 *    deshace y el motor lo clasifica como rechazo permanente.
 *
 * Una sentencia con `guarda` (SYNC-30) se comprueba en cuanto se ejecuta, en cualquiera de las dos
 * pasadas: si no se cumple, `GuardaIncumplida` sale de la transacción y no queda nada del lote. No es
 * una FK rota, así que no se repite aplazando.
 *
 * El paso 2 recorre las tablas con FK (unos 230 ms con 250.000 líneas), pero sólo lo paga quien
 * necesita el aplazamiento o trae una FK rota de verdad. Quien aplica varios lotes en un mismo turno
 * (`MotorTenantHub.aplicarLote`) pone tope a ese trabajo con `alAplazar`: se le pregunta justo antes
 * de repetir aplazando, y si dice que no se lanza `HaceFaltaAplazar` con la base como estaba.
 */
export function loteEnBruto(
	storage: DurableObjectStorage,
	sentencias: Sentencia[],
	opciones: { alAplazar?: () => boolean; tope?: TopeDeOperacion } = {},
): FilasEnBruto[] {
	const sql = storage.sql;
	const { tope } = opciones;
	const pideAplazar = sentencias.some((s) => APLAZAR_FK.test(partes(s).texto));

	const correr = (aplazar: boolean): FilasEnBruto[] =>
		storage.transactionSync(() => {
			if (aplazar) sql.exec("PRAGMA defer_foreign_keys = ON;");
			// AUD-36: lo que lleva escrito este intento, para pararlo en cuanto se pasa de su tope.
			const tamanoAntes = tope ? sql.databaseSize : 0;
			let filasDelIntento = 0;
			try {
				const salida = sentencias.map((s) => {
					if (APLAZAR_FK.test(partes(s).texto)) return VACIO;
					const filas = ejecutarEnBruto(sql, s);
					if (tope) {
						const escritas = filas.filasEscritas ?? 0;
						filasDelIntento += escritas;
						tope.medida.filas += escritas;
						if (filasDelIntento > tope.filas || sql.databaseSize - tamanoAntes > tope.bytes) {
							throw operacionDemasiadoGrande();
						}
					}
					if (typeof s !== "string" && s.guarda) exigirGuarda(s.guarda, filas);
					return filas;
				});
				if (aplazar) {
					const rota = sql.exec("PRAGMA foreign_key_check;").toArray()[0] as
						| { table?: string; parent?: string }
						| undefined;
					if (rota) {
						throw new Error(
							`FOREIGN KEY constraint failed: ${rota.table ?? "?"} → ${rota.parent ?? "?"} (aplazada)`,
						);
					}
				}
				return salida;
			} finally {
				// El aplazamiento es de la conexión, no de la transacción: deshacer el lote no lo apaga.
				if (aplazar) sql.exec("PRAGMA defer_foreign_keys = OFF;");
			}
		});

	if (!pideAplazar) return correr(false);
	try {
		return correr(false);
	} catch (e) {
		if (!esFkRota(e)) throw e;
		if (opciones.alAplazar && !opciones.alAplazar()) throw new HaceFaltaAplazar();
		return correr(true);
	}
}

/**
 * SYNC-30 · La guarda de un paso `guard` no se cumple: la escritura no se aplica y contesta el error
 * de negocio de la guarda. Es un `HubError` (lo que lleva el resultado del RPC `aplicar`) y no un
 * fallo: el motor no lo anota como tal.
 */
export class GuardaIncumplida extends HubError {
	constructor(guarda: Guarda) {
		super(guarda.error, guarda.status);
		this.name = "GuardaIncumplida";
	}
}

/**
 * ¿Se cumple la guarda? Su consulta da una fila cuyo primer valor es un número distinto de 0. Sin
 * fila, con `NULL` o con otra cosa, no se cumple. Lanzar aquí, dentro de `transactionSync`, deshace
 * todo lo que el lote llevaba hecho.
 */
function exigirGuarda(guarda: Guarda, filas: FilasEnBruto): void {
	const valor = filas.rows[0]?.[0];
	const cumple = typeof valor === "number" ? valor !== 0 : typeof valor === "bigint" ? valor !== 0n : false;
	if (!cumple) throw new GuardaIncumplida(guarda);
}

/**
 * El lote sólo entra aplazando las claves foráneas (o trae una rota de verdad) y quien lo aplica no
 * ha querido pagar ahora esa comprobación (`loteEnBruto`, `alAplazar`). No dice nada de la
 * operación: no se ha aplicado nada y se puede volver a mandar.
 */
export class HaceFaltaAplazar extends Error {
	constructor() {
		super("hace_falta_aplazar");
	}
}

/** Las filas en bruto con la forma de una `Row` de libsql: por nombre y por posición. */
function aResultSet(b: FilasEnBruto): ResultSet {
	const rows = b.rows.map((valores) => {
		const fila: Record<string | number, unknown> = {};
		Object.defineProperty(fila, "length", { value: valores.length });
		valores.forEach((v, i) => {
			Object.defineProperty(fila, i, { value: v });
			const col = b.columns[i];
			if (col !== undefined && !Object.prototype.hasOwnProperty.call(fila, col)) {
				Object.defineProperty(fila, col, { value: v, enumerable: true, configurable: true, writable: true });
			}
		});
		return fila;
	});
	const lastInsertRowid = b.lastInsertRowid == null ? undefined : BigInt(b.lastInsertRowid);
	return {
		columns: b.columns,
		columnTypes: b.columns.map(() => ""),
		rows: rows as any,
		rowsAffected: b.rowsAffected,
		lastInsertRowid,
		toJSON() {
			return {
				columns: b.columns,
				columnTypes: b.columns.map(() => ""),
				rows: b.rows,
				rowsAffected: b.rowsAffected,
				lastInsertRowid: lastInsertRowid?.toString() ?? null,
			};
		},
	};
}

function sinTransacciones(): never {
	throw new Error(
		"tenantHub.sqlite: la base del negocio no abre transacciones interactivas; usa batch()",
	);
}

/** Un `Client` de libsql sobre el SQLite del propio Durable Object. */
export function clienteLocal(storage: DurableObjectStorage): Client {
	return {
		async execute(entrada: Sentencia, args?: unknown[]) {
			const s = typeof entrada === "string" && args ? { sql: entrada, args } : entrada;
			return aResultSet(ejecutarEnBruto(storage.sql, s));
		},
		async batch(sentencias: Sentencia[]) {
			return loteEnBruto(storage, sentencias).map(aResultSet);
		},
		transaction: sinTransacciones,
		executeMultiple: sinTransacciones,
		migrate: sinTransacciones,
		sync: async () => undefined,
		close() {},
		closed: false,
		protocol: "file",
	} as unknown as Client;
}

// ---------------- Esquema ----------------

/** Comentarios fuera: el `exec` de varias sentencias del DO se atraganta con algunos. */
function sinComentarios(sql: string): string {
	return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
}

/** ¿Este negocio tiene ya su base? La crea el alta (`aprovisionar`). */
export function baseAprovisionada(sql: SqlStorage): boolean {
	return (
		sql
			.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_migrations';")
			.toArray().length > 0
	);
}

type MigracionPendiente = { name: string; sql: string; hash: string };

/**
 * Las migraciones que le faltan a esta base, en orden. Lanza `migration_altered` si una ya
 * aplicada cambió (mismo nombre, otro hash), como el runner de la Main.
 */
function migracionesPendientes(
	sql: SqlStorage,
	migraciones: { name: string; sql: string }[],
	hashes: string[],
): MigracionPendiente[] {
	// `_migrations` nace dentro de la transacción de la primera migración: si ésta falla, el negocio
	// sigue sin base (`baseAprovisionada` = false) en vez de quedarse con una tabla de control vacía.
	const aplicadas = new Map(
		baseAprovisionada(sql)
			? sql
					.exec("SELECT name, hash FROM _migrations;")
					.toArray()
					.map((r: any) => [String(r.name), String(r.hash)] as const)
			: [],
	);
	const pendientes: MigracionPendiente[] = [];
	migraciones.forEach((mig, i) => {
		const hash = hashes[i];
		const previa = aplicadas.get(mig.name);
		if (previa === undefined) {
			pendientes.push({ ...mig, hash });
			return;
		}
		if (previa !== hash) {
			throw new HubError("migration_altered", 500, {
				message:
					`migration_altered: '${mig.name}' fue modificada tras aplicarse (hash distinto). ` +
					`Nunca edites una migración ya publicada: crea una nueva.`,
			});
		}
	});
	return pendientes;
}

/** ¿Están activas las claves foráneas en la conexión de este DO? */
function fkActivas(sql: SqlStorage): boolean {
	return Number((sql.exec("PRAGMA foreign_keys;").toArray()[0] as any)?.foreign_keys) === 1;
}

/**
 * Enciende o apaga las claves foráneas de la conexión, y comprueba que ha surtido efecto.
 *
 * SQLite ignora este PRAGMA, sin avisar, mientras haya una transacción abierta, y el DO abre una
 * en cuanto se escribe algo y no la cierra hasta que lo escrito está confirmado: ni al acabar un
 * `transactionSync` ni cediendo a las microtareas. Si la orden no surte efecto se espera a esa
 * confirmación (`storage.sync()`) y se repite. Y como es de la conexión, lo que se deja puesto lo
 * hereda todo lo que venga detrás en este objeto. Comprobado en `test/sondaSqliteDo.test.ts`.
 */
async function ponerFk(storage: DurableObjectStorage, activas: boolean): Promise<void> {
	const sql = storage.sql;
	const orden = `PRAGMA foreign_keys = ${activas ? "ON" : "OFF"};`;
	if (fkActivas(sql) === activas) return;
	sql.exec(orden);
	if (fkActivas(sql) === activas) return;
	await storage.sync();
	sql.exec(orden);
	if (fkActivas(sql) !== activas) {
		throw new Error(
			`tenantHub.sqlite: no se han podido ${activas ? "activar" : "apagar"} las claves foráneas de la base`,
		);
	}
}

/** Una migración, su comprobación de integridad y su registro en `_migrations`: todo o nada. */
function aplicarMigracion(storage: DurableObjectStorage, mig: MigracionPendiente): void {
	const sql = storage.sql;
	storage.transactionSync(() => {
		sql.exec(
			"CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, hash TEXT NOT NULL, applied_at INTEGER NOT NULL);",
		);
		sql.exec(sinComentarios(normalize(mig.sql)));
		// Con las FK apagadas nadie las comprueba en caliente: se mira a mano que la migración no ha
		// dejado huérfanas antes de confirmarla.
		const rota = sql.exec("PRAGMA foreign_key_check;").toArray()[0] as { table?: string } | undefined;
		if (rota) {
			throw new Error(
				`La migración '${mig.name}' dejó integridad referencial rota (foreign_key_check señala ` +
					`'${rota.table ?? "?"}'). Se revierte.`,
			);
		}
		sql.exec(
			"INSERT INTO _migrations (name, hash, applied_at) VALUES (?1, ?2, ?3);",
			mig.name,
			mig.hash,
			Date.now(),
		);
	});
}

/**
 * Aplica las migraciones pendientes (`server/tenantMigrations.ts`), cada una con su registro en
 * `_migrations` y en su propia transacción, como el runner de la Main (mismo nombre, mismo hash).
 * Falla con `migration_altered` si una ya aplicada cambió.
 *
 * **Con las claves foráneas apagadas alrededor de la tanda**, también como en la Main
 * (`migrations.rs::run`). Una migración que le quita una restricción a una tabla tiene que
 * reconstruirla: crear la nueva, copiar, borrar la vieja y renombrar. Con las FK activas, ese
 * `DROP` borra las filas de la tabla y se lleva en cascada las de sus hijas (`ON DELETE CASCADE`),
 * sin error y sin nada que `foreign_key_check` pueda ver después; con una hija sin acción, falla.
 * Apagadas, cada migración pasa `foreign_key_check` antes de confirmarse.
 *
 * ⚠️ Mientras están apagadas no puede correr nada más contra la base: quien llama lo hace dentro
 * de `blockConcurrencyWhile` (`MotorTenantHub.migrarEnExclusiva`). Aquí hay dos esperas con ellas
 * apagadas, las de `ponerFk`.
 */
export async function migrarBaseLocal(storage: DurableObjectStorage): Promise<void> {
	const migraciones = MIGRATIONS;
	const hashes = await Promise.all(migraciones.map((m) => sha256Hex(normalize(m.sql))));
	const sql = storage.sql;

	if (migracionesPendientes(sql, migraciones, hashes).length === 0) {
		// Una tanda anterior que no llegó a encenderlas las habría dejado apagadas en esta conexión.
		await ponerFk(storage, true);
		return;
	}

	await ponerFk(storage, false);
	let fallo: { error: unknown } | null = null;
	try {
		// Lo pendiente se vuelve a mirar aquí, ya sin esperas hasta acabar la tanda.
		for (const mig of migracionesPendientes(sql, migraciones, hashes)) aplicarMigracion(storage, mig);
	} catch (error) {
		fallo = { error };
	}
	try {
		await ponerFk(storage, true);
	} catch (error) {
		// El fallo de la migración manda sobre el de volver a encenderlas.
		if (!fallo) throw error;
	}
	if (fallo) throw fallo.error;
}
