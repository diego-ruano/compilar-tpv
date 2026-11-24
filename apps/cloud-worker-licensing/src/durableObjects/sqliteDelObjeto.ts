// src/durableObjects/sqliteDelObjeto.ts
//
// Lo que comparten las dos bases que viven en el SQLite de un Durable Object: la de cada negocio, en
// su `TenantHub` (`tenantHub.sqlite.ts`), y la central, en su `BaseCentral` (`baseCentral.ts`). Qué
// sentencias admite cada una y cómo convierte sus argumentos lo decide cada una; aquí está lo que
// hacen igual: ejecutar una sentencia, dar sus filas por nombre y por posición, encender y apagar las
// claves foráneas, y aplicar sus migraciones.
//
// Diferencias con lo que el resto del worker espera de una base (`lib/sql.ts`), que este fichero
// absorbe:
//
// - `rowsWritten` del cursor cuenta también las filas de índice, así que NO es `rowsAffected`. Se
//   pregunta a SQLite con `changes()`.
// - No hay `lastInsertRowid`: se pregunta con `last_insert_rowid()` tras un INSERT.
// - `BEGIN`/`SAVEPOINT` no están permitidos: la atomicidad de un lote la da `transactionSync`.
// - Un entero se lee como `number`: uno de más de 2^53 llega redondeado, sin aviso. Las dos bases
//   guardan milisegundos, céntimos, recuentos y secuencias, muy por debajo.

import { HubError } from "../lib/errorHttp";
import type { Fila, Resultado, Valor } from "../lib/sql";
import { sha256HexStr } from "../server/utils/crypto";

/** Las filas de una sentencia en bruto: columnas y valores, sin el envoltorio de `Resultado`. */
export type FilasEnBruto = {
	columns: string[];
	rows: Valor[][];
	rowsAffected: number;
	lastInsertRowid: number | null;
	/** AUD-36: las filas que ha escrito la sentencia, con las de sus índices y triggers (`rowsWritten`). */
	filasEscritas?: number;
};

const PRIMERA_PALABRA = /^\s*(\w+)/;

/** La primera palabra de una sentencia, en mayúsculas: su verbo (`SELECT`, `INSERT`…). */
export function verboDe(texto: string): string {
	return (PRIMERA_PALABRA.exec(texto)?.[1] ?? "").toUpperCase();
}

/**
 * Ejecuta una sentencia y devuelve sus filas en bruto, con `rowsAffected` contado por `changes()`.
 * Los argumentos llegan ya convertidos por la base que la ejecuta.
 */
export function ejecutarEnBruto(sql: SqlStorage, texto: string, args: readonly unknown[]): FilasEnBruto {
	const cursor = sql.exec(texto, ...args);
	const columns = [...cursor.columnNames];
	const rows = Array.from(cursor.raw()) as Valor[][];

	const verbo = verboDe(texto);
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

/**
 * Las filas en bruto como un `Resultado`: cada fila se lee por nombre y por posición. Las posiciones
 * no son enumerables, para que `Object.keys` y `JSON.stringify` sólo vean las columnas; si dos
 * columnas se llaman igual, el nombre se queda con la primera.
 */
export function aResultado(b: FilasEnBruto): Resultado {
	const rows = b.rows.map((valores) => {
		const fila: Record<string | number, Valor> = {};
		Object.defineProperty(fila, "length", { value: valores.length });
		valores.forEach((v, i) => {
			Object.defineProperty(fila, i, { value: v });
			const col = b.columns[i];
			if (col !== undefined && !Object.prototype.hasOwnProperty.call(fila, col)) {
				Object.defineProperty(fila, col, { value: v, enumerable: true, configurable: true, writable: true });
			}
		});
		return fila as Fila;
	});
	return {
		columns: b.columns,
		rows,
		rowsAffected: b.rowsAffected,
		lastInsertRowid: b.lastInsertRowid,
	};
}

// ---------------- Claves foráneas ----------------

/** ¿Están activas las claves foráneas en la conexión de este DO? */
export function fkActivas(sql: SqlStorage): boolean {
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
export async function ponerFk(storage: DurableObjectStorage, activas: boolean): Promise<void> {
	const sql = storage.sql;
	const orden = `PRAGMA foreign_keys = ${activas ? "ON" : "OFF"};`;
	if (fkActivas(sql) === activas) return;
	sql.exec(orden);
	if (fkActivas(sql) === activas) return;
	await storage.sync();
	sql.exec(orden);
	if (fkActivas(sql) !== activas) {
		throw new Error(`No se han podido ${activas ? "activar" : "apagar"} las claves foráneas de la base`);
	}
}

// ---------------- Esquema ----------------

/** Una migración: su nombre (el del fichero) y su SQL. */
export type Migracion = { name: string; sql: string };

/** Normaliza finales de línea (CRLF → LF) para que el hash sea estable entre sistemas. */
function finesDeLineaLf(s: string): string {
	return s.replace(/\r\n/g, "\n");
}

/** Comentarios fuera: el `exec` de varias sentencias del DO se atraganta con algunos. */
function sinComentarios(sql: string): string {
	return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
}

/** ¿Tiene ya esta base su esquema? Lo marca `_migrations`, que nace con la primera migración. */
export function baseAprovisionada(sql: SqlStorage): boolean {
	return (
		sql
			.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_migrations';")
			.toArray().length > 0
	);
}

type MigracionPendiente = Migracion & { hash: string };

/**
 * Las migraciones que le faltan a esta base, en orden. Lanza `migration_altered` si una ya
 * aplicada cambió (mismo nombre, otro hash), como el runner de la Main.
 */
function migracionesPendientes(
	sql: SqlStorage,
	migraciones: readonly Migracion[],
	hashes: string[],
): MigracionPendiente[] {
	// `_migrations` nace dentro de la transacción de la primera migración: si ésta falla, la base
	// sigue sin aprovisionar (`baseAprovisionada` = false) en vez de quedarse con una tabla de control
	// vacía.
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

/** Una migración, su comprobación de integridad y su registro en `_migrations`: todo o nada. */
function aplicarMigracion(storage: DurableObjectStorage, mig: MigracionPendiente): void {
	const sql = storage.sql;
	storage.transactionSync(() => {
		sql.exec(
			"CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, hash TEXT NOT NULL, applied_at INTEGER NOT NULL);",
		);
		sql.exec(sinComentarios(finesDeLineaLf(mig.sql)));
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
 * Aplica las migraciones pendientes de `migraciones`, cada una con su registro en `_migrations`
 * (nombre y hash SHA-256 del texto con finales LF) y en su propia transacción, como el runner de la
 * Main. Falla con `migration_altered` si una ya aplicada cambió.
 *
 * **Con las claves foráneas apagadas alrededor de la tanda**, también como en la Main
 * (`migrations.rs::run`). Una migración que le quita una restricción a una tabla tiene que
 * reconstruirla: crear la nueva, copiar, borrar la vieja y renombrar. Con las FK activas, ese
 * `DROP` borra las filas de la tabla y se lleva en cascada las de sus hijas (`ON DELETE CASCADE`),
 * sin error y sin nada que `foreign_key_check` pueda ver después; con una hija sin acción, falla.
 * Apagadas, cada migración pasa `foreign_key_check` antes de confirmarse.
 *
 * ⚠️ Mientras están apagadas no puede correr nada más contra la base: quien llama lo hace dentro
 * de `blockConcurrencyWhile`. Aquí hay dos esperas con ellas apagadas, las de `ponerFk`.
 */
export async function migrarBase(storage: DurableObjectStorage, migraciones: readonly Migracion[]): Promise<void> {
	const hashes = await Promise.all(migraciones.map((m) => sha256HexStr(finesDeLineaLf(m.sql))));
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
