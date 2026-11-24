// src/server/db.ts
import { createClient, type Client, type ResultSet, type Transaction } from "@libsql/client/web";
import type { Base, Fila, Resultado, Sql } from "../lib/sql";
import { medirTramo } from "../observability/tiempos";

export interface TursoEnv {
	TURSO_DATABASE_URL: string;
	TURSO_AUTH_TOKEN: string;
}

/** Una transacción abierta sobre la base central: lo que recibe el cuerpo de `enTransaccion`. */
interface TransaccionCentral extends Sql {
	commit(): Promise<void>;
	rollback(): Promise<void>;
	close(): void;
}

/**
 * La base central: sentencias sueltas, lotes (siempre de escritura) y transacciones interactivas
 * (`enTransaccion` y la copia diaria, `copiaBaseCentral.ts`).
 */
export interface BaseCentralEnTurso extends Base {
	transaction(modo: "write" | "read"): Promise<TransaccionCentral>;
}

let _client: BaseCentralEnTurso | null = null;

export function getDb(env: TursoEnv): BaseCentralEnTurso {
	if (_client) return _client;

	const url = String(env.TURSO_DATABASE_URL || "").trim();
	const authToken = String(env.TURSO_AUTH_TOKEN || "").trim();

	if (!url) throw new Error("missing_env_TURSO_DATABASE_URL");
	if (!authToken) throw new Error("missing_env_TURSO_AUTH_TOKEN");

	_client = conTiempos(baseSobreTurso(createClient({ url, authToken })));
	return _client;
}

/**
 * Un resultado de libsql con la forma de `lib/sql.ts`. El cliente lee los enteros como `number`
 * (su `intMode` por defecto: uno que no cabe lanza), así que ninguna fila trae un `bigint`;
 * `lastInsertRowid` sí lo es, y aquí pasa a número.
 */
function aResultado(rs: ResultSet): Resultado {
	return {
		columns: rs.columns,
		rows: rs.rows as unknown as Fila[],
		rowsAffected: rs.rowsAffected,
		lastInsertRowid: rs.lastInsertRowid === undefined ? null : Number(rs.lastInsertRowid),
	};
}

function transaccionSobreTurso(tx: Transaction): TransaccionCentral {
	return {
		execute: async (sentencia) => aResultado(await tx.execute(sentencia)),
		commit: () => tx.commit(),
		rollback: () => tx.rollback(),
		close: () => tx.close(),
	};
}

/**
 * Un cliente de libsql con la forma de `lib/sql.ts`. Un lote de la base central abre siempre una
 * transacción de escritura: es lo que necesitan los dos que hay (el ticket del socket y su canje).
 */
export function baseSobreTurso(cliente: Client): BaseCentralEnTurso {
	return {
		execute: async (sentencia) => aResultado(await cliente.execute(sentencia)),
		batch: async (sentencias) => (await cliente.batch(sentencias, "write")).map(aResultado),
		transaction: async (modo) => transaccionSobreTurso(await cliente.transaction(modo)),
	};
}

/** Cada viaje a la base central suma al tramo `central` de la petición (`observability/tiempos.ts`). */
function conTiempos(db: BaseCentralEnTurso): BaseCentralEnTurso {
	return {
		execute: (sentencia) => medirTramo("central", () => db.execute(sentencia)),
		batch: (sentencias) => medirTramo("central", () => db.batch(sentencias)),
		transaction: (modo) => medirTramo("central", () => db.transaction(modo)),
	};
}

/**
 * Ejecuta `fn` en una transacción de escritura: o entra todo lo que escribe, o no entra nada.
 *
 * REV-01: lo que tiene que ir junto no puede ir en sentencias sueltas. Si una falla a mitad, lo
 * que ya se escribió se queda, y un reintento que no sabe dónde se paró lo repite — así se sumaban
 * dos veces los meses de una renovación. Lo que no sea base de datos (llamar a Stripe, mandar un
 * correo) va fuera: una transacción abierta bloquea las escrituras de la base central entera.
 */
export async function enTransaccion<T>(
	db: BaseCentralEnTurso,
	fn: (tx: Sql) => Promise<T>,
): Promise<T> {
	const tx = await db.transaction("write");
	try {
		const resultado = await fn(tx);
		await tx.commit();
		return resultado;
	} catch (e) {
		await tx.rollback().catch(() => {});
		throw e;
	} finally {
		tx.close();
	}
}

export async function exec(db: Sql, sql: string, args: any[] = []) {
	// El `await` no sobra: sin el, esta funcion DEVUELVE la promesa de `execute` en vez de
	// esperarla, y el runtime tarda un par de ticks en adoptarla. En ese hueco un rechazo cuenta
	// como no gestionado —aunque el llamante lo capture—, y workerd lo reporta como unhandled
	// rejection.
	return await db.execute({ sql, args });
}

/**
 * Filas que tocó una escritura. Estaba copiado en SEIS ficheros de pairing, y los dos nombres son
 * a propósito: el driver HTTP de libsql devuelve `rowsAffected` y el nativo `rows_affected`.
 *
 * Es lo que distingue «no había nada que cambiar» de «se cambió», que en este dominio es la
 * diferencia entre una carrera perdida y una operación buena.
 */
export function rowsAffected(result: any): number {
	return Number(result?.rowsAffected ?? result?.rows_affected ?? 0);
}
