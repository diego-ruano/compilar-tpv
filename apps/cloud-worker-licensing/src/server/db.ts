// src/server/db.ts
import { createClient, type Client, type Transaction } from "@libsql/client/web";

/**
 * Donde se puede ejecutar una sentencia: la conexión o una transacción abierta sobre ella. Las
 * funciones del store lo aceptan así para poder componerse dentro de `enTransaccion`.
 */
export type Sql = Pick<Client, "execute">;

export interface TursoEnv {
	TURSO_DATABASE_URL: string;
	TURSO_AUTH_TOKEN: string;
}

let _client: Client | null = null;

export function getDb(env: TursoEnv): Client {
	if (_client) return _client;

	const url = String(env.TURSO_DATABASE_URL || "").trim();
	const authToken = String(env.TURSO_AUTH_TOKEN || "").trim();

	if (!url) throw new Error("missing_env_TURSO_DATABASE_URL");
	if (!authToken) throw new Error("missing_env_TURSO_AUTH_TOKEN");

	_client = createClient({ url, authToken });
	return _client;
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
	db: Client,
	fn: (tx: Transaction) => Promise<T>,
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

export async function execMany(db: Client, statements: { sql: string; args?: any[] }[]) {
	// libsql HTTP no garantiza transacciones multi-statement igual que sqlite local,
	// pero esto reduce round-trips.
	for (const st of statements) {
		await db.execute({ sql: st.sql, args: st.args || [] });
	}
}
