// src/lib/tenantClient.ts
//
// Resolución + caché (a nivel de isolate) del cliente Turso de cada tenant, para
// las LECTURAS de la API (van directas a Turso, sin pasar por el Durable Object).
//
// - Cachea el cliente por tenant con un TTL corto para evitar un SELECT a la DB
//   central en cada petición.
// - Si una query falla por 401 (token rotado), invalida la caché, re-resuelve con
//   `forceRotate` y reintenta una vez. Mismo criterio que el DO.
// - Fija «ahora» a la hora LOCAL de quien pregunta antes de ejecutar (REV-03, ver abajo).
//
// ── REV-03: «hoy» es el de quien pregunta, no el de Turso ──────────────────────────────────────
//
// Estas lecturas se ejecutan en Turso, que corre en UTC, así que su `'localtime'` ES UTC. Un
// `date('now','localtime')` dentro de una consulta devolvía el día de Turso, no el del bar: entre
// medianoche y las dos de la mañana (verano en España) todavía era ayer. Eso salía en las tareas
// «de hoy», en las estadísticas, en las reservas próximas… y, lo peor, en la fecha con la que se
// guardaba un fichaje, que es un registro de jornada obligatorio.
//
// La cura es la que ya usan las ESCRITURAS (CFG-04): la hora la pone quien emite la petición
// (`X-Client-Now`) y se fija a literal ANTES de ejecutar, con la misma función que usa el Durable
// Object (`rewriteNowInSql`). Se hace aquí, en el único punto por el que pasan todas las lecturas,
// y no consulta a consulta: una que se añada mañana no puede olvidarse de hacerlo.
//
// Sin cabecera (o con una fuera de la deriva admisible) no se reescribe nada y manda el reloj de
// Turso, que es como se comportaba antes. Es lo correcto: quien no dice su hora no puede esperar
// que se la adivinen.

import { createClient, type Client } from "@libsql/client/web";

import type { Env } from "../env";
import { getDb } from "../server/db";
import { resolveTenantDbCredentials, ensureTenantMigrated } from "../server/db/tenantDb";
import { parseClientNow, rewriteNowInSql } from "../durableObjects/tenantHub.tiempo";
import { isTursoAuthError } from "./tursoAuthError";

type Cached = { client: Client; expiresAtMs: number };

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, Cached>();

async function build(env: Env, tenantId: string, forceRotate: boolean): Promise<Client> {
	const creds = await resolveTenantDbCredentials(
		getDb(env),
		env as any,
		tenantId,
		forceRotate,
	);

	const client = createClient({
		url: creds.tursoUrl,
		authToken: creds.tursoAuthToken,
		intMode: "number",
	});

	cache.set(tenantId, { client, expiresAtMs: Date.now() + CACHE_TTL_MS });
	return client;
}

async function getTenantClient(env: Env, tenantId: string): Promise<Client> {
	const hit = cache.get(tenantId);
	const client =
		hit && hit.expiresAtMs > Date.now() ? hit.client : await build(env, tenantId, false);

	// Guard de migración: garantiza el esquema al día una vez por isolate (no-op tras la primera
	// vez). Cubre el caso de un tenant ya activo cuando se publica un cambio de esquema.
	await ensureTenantMigrated(client, tenantId);

	return client;
}

/**
 * Lo que `tenantQuery` necesita de la petición. Es la forma estructural de un `Context` de Hono,
 * escrita a mano para no atar esta pieza a los genéricos del router (y para poder llamarla desde
 * un test con un objeto de tres campos).
 */
export type ContextoDeLectura = {
	env: Env;
	get: (clave: "tenantId") => string;
	req: { header: (nombre: string) => string | undefined };
};

/** Una sentencia tal y como la acepta el cliente de libsql: texto suelto, o texto con argumentos. */
type Sentencia = string | { sql: string; args?: unknown };

/**
 * REV-03: el mismo cliente, pero resolviendo «ahora» a la hora local de quien pregunta.
 *
 * Va por `Proxy` y no copiando el objeto porque el cliente de libsql es una instancia con estado
 * propio: un `{...db}` perdería sus métodos (viven en el prototipo) y un `Object.create(db)`
 * rompería sus campos privados. Aquí sólo se interceptan las dos puertas por las que sale SQL
 * —`execute` y `batch`— y todo lo demás se delega tal cual, atado al cliente de verdad. La
 * tercera, `transaction()`, **revienta**: ver abajo.
 */
export function conLaHoraDeQuienPregunta(db: Client, ahoraLocal: string): Client {
	const reescribir = (stmt: Sentencia): Sentencia =>
		typeof stmt === "string"
			? rewriteNowInSql(stmt, ahoraLocal)
			: { ...stmt, sql: rewriteNowInSql(stmt.sql, ahoraLocal) };

	// Lo que venga detras se reenvia tal cual: `execute` admite `(sentencia)` y tambien `(sql, args)`,
	// y quedarse solo con el primer argumento convertiria una consulta con parametros en una sin
	// ellos. Hoy ninguna lectura usa esa forma; manana puede.
	return new Proxy(db, {
		get(target, prop) {
			if (prop === "execute") {
				return (stmt: Sentencia, ...resto: unknown[]) =>
					(target.execute as any)(reescribir(stmt), ...resto);
			}
			if (prop === "batch") {
				return (stmts: Sentencia[], ...resto: unknown[]) =>
					(target.batch as any)(stmts.map(reescribir), ...resto);
			}
			// La tercera puerta por la que puede salir SQL. Ninguna lectura abre transacciones, y si
			// alguna llegara a hacerlo su SQL saldría SIN fijar la hora: devolvería el día del
			// servidor y nadie se enteraría — no hay error, sólo datos de otro día. Así que se
			// prohibe, y quien la escriba lo sabe en el acto y con el motivo delante, en vez de
			// descubrirlo un cliente de madrugada. Si algún día hace falta de verdad, lo que hay que
			// hacer es envolver la transacción, no quitar esto.
			if (prop === "transaction") {
				return () => {
					throw new Error(
						"tenantQuery: una lectura no abre transacciones (REV-03). Si hace falta, envuelve " +
							"la transaccion para que tambien fije la hora de quien pregunta.",
					);
				};
			}
			const valor = Reflect.get(target, prop, target);
			return typeof valor === "function" ? valor.bind(target) : valor;
		},
	});
}

/**
 * Ejecuta una lectura contra la DB del tenant. Reintenta una vez con credenciales
 * rotadas si el token había caducado (401).
 *
 * ⚠️ La resolución del cliente va DENTRO del `try` a propósito. `getTenantClient` habla con Turso
 * por dos vías (resolver credenciales y, sobre todo, el guard de migración `ensureTenantMigrated`),
 * así que también puede lanzar 401. Cuando esa llamada quedaba fuera del `try`, un token caducado
 * hacía que el guard lanzase el 401 antes de llegar al `catch`: la rotación no se ejecutaba NUNCA y
 * **todas** las lecturas REST de la Handy se quedaban en 500 permanente (`internal_error`), sin
 * recuperarse solas. El sync seguía funcionando porque el Durable Object tiene su propio reintento
 * con rotación (`withTenantDbRetry`), de ahí que fallasen las lecturas pero no la replicación.
 */
export async function tenantQuery<T>(
	c: ContextoDeLectura,
	fn: (db: Client) => Promise<T>,
): Promise<T> {
	// REV-03: la hora local del emisor, validada igual que en las escrituras (formato y deriva).
	const ahoraLocal = parseClientNow(c.req.header("X-Client-Now"));
	return conElClienteDelTenant(c.env, c.get("tenantId"), (db) =>
		fn(ahoraLocal ? conLaHoraDeQuienPregunta(db, ahoraLocal) : db),
	);
}

/**
 * Lo mismo que `tenantQuery` para quien no tiene un dispositivo que diga su hora: la reserva desde
 * la web, que pregunta desde un navegador cualquiera. «Ahora» lo calcula `hora` con el propio
 * cliente (la zona del negocio) y se fija igual en todas las sentencias de `fn`, que lo recibe
 * también para no tener que volver a calcularlo.
 */
export async function lecturaConHora<T>(
	env: Env,
	tenantId: string,
	hora: (db: Client) => Promise<string>,
	fn: (db: Client, ahoraLocal: string) => Promise<T>,
): Promise<T> {
	return conElClienteDelTenant(env, tenantId, async (db) => {
		const ahoraLocal = await hora(db);
		return fn(conLaHoraDeQuienPregunta(db, ahoraLocal), ahoraLocal);
	});
}

async function conElClienteDelTenant<T>(env: Env, tenantId: string, fn: (db: Client) => Promise<T>): Promise<T> {
	try {
		const db = await getTenantClient(env, tenantId);
		return await fn(db);
	} catch (e) {
		if (!isTursoAuthError(e)) throw e;
		cache.delete(tenantId);
		const fresh = await build(env, tenantId, true);
		// Si el 401 vino del guard de migración, su entrada ya se invalidó al fallar: hay que
		// reintentarlo con el token nuevo antes de la query (si ya estaba migrado, es un no-op).
		await ensureTenantMigrated(fresh, tenantId);
		return await fn(fresh);
	}
}
