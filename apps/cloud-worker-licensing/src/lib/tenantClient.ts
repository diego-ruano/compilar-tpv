// src/lib/tenantClient.ts
//
// El cliente de la base de cada negocio para las LECTURAS de la API.
//
// La base vive en el SQLite del TenantHub del negocio, así que cada consulta es una llamada RPC al
// DO (`consultar`). El `Client` que reciben las rutas tiene la misma forma que el de libsql
// (`execute`, `batch`).
//
// - `consultar` sólo lee: una escritura del negocio va por el motor del DO (`lib/hub.ts`), que es
//   quien la apunta y la difunde. Lo único que una ruta escribe por aquí es el estado propio de la
//   nube (el freno del PIN, el checkpoint de la purga, el resumen diario de las estadísticas), que
//   no se replica: dentro del DO, con el cliente de al lado; desde el Worker, por su propia puerta
//   (`anotarEstado`), una sentencia suelta o un lote en el que todas lo son.
// - Fija «ahora» a la hora LOCAL de quien pregunta antes de ejecutar (REV-03, ver abajo).
//
// ── REV-03: «hoy» es el de quien pregunta, no el de la base ──────────────────────────────────────
//
// Estas lecturas se ejecutan en la base, que corre en UTC, así que su `'localtime'` ES UTC. Un
// `date('now','localtime')` dentro de una consulta devolvía el día de la base, no el del bar: entre
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
// La base, que es como se comportaba antes. Es lo correcto: quien no dice su hora no puede esperar
// que se la adivinen.

import type { Client, ResultSet } from "@libsql/client/web";

import type { Env } from "../env";
import { HubError } from "./errorHttp";
import { hubDe } from "./hub";
import { hubLocal } from "./hubLocal";
import { medirTramo } from "../observability/tiempos";
import { parseClientNow, rewriteNowInSql } from "../durableObjects/tenantHub.tiempo";
import { aResultSet, esEscrituraDeEstado, type Sentencia as SentenciaDelHub } from "../durableObjects/tenantHub.sqlite";
import type { RespuestaDeConsulta } from "../durableObjects/tenantHub.rpc";

function sinTransacciones(): never {
	throw new Error(
		"tenantQuery: la base del negocio no abre transacciones interactivas desde el Worker; usa batch()",
	);
}

/**
 * Un `Client` de libsql cuyas sentencias se ejecutan en el TenantHub del negocio.
 *
 * Una llamada RPC por `execute` y otra por `batch`: una ruta con N consultas seguidas hace N
 * viajes al DO. Por eso las rutas de negocio se ejecutan dentro del propio DO (`lib/enElHub.ts`), y
 * ahí este cliente lee del SQLite de al lado, sin viaje. El migrado del esquema lo hace el DO en su
 * primer acceso.
 */
export function clienteDelHub(env: Env, tenantId: string): Client {
	const stub = hubDe(env, tenantId);
	const pedir = async (sentencias: SentenciaDelHub[], enLote: boolean): Promise<ResultSet[]> => {
		const local = hubLocal(tenantId);
		if (local) {
			const db = await local.base();
			return enLote ? db.batch(sentencias as any) : [await db.execute(sentencias[0] as any)];
		}
		// Los tipos de RPC no aceptan `unknown` (valores de SQLite): se afirma la forma que devuelve el DO.
		// Estado propio de la nube: una sentencia suelta, o un lote en el que todas lo son (entra todo
		// o nada). Un lote que mezcle una lectura o una escritura del negocio va por `consultar`, que
		// lo rechaza.
		const esEstado = sentencias.length > 0 && sentencias.every((s) => esEscrituraDeEstado(s));
		const r = (
			esEstado
				? await medirTramo("hub-anota", () =>
						stub.anotarEstado(tenantId, (enLote ? sentencias : sentencias[0]) as any),
					)
				: await medirTramo("hub-lee", () => stub.consultar(tenantId, sentencias as any, enLote))
		) as unknown as RespuestaDeConsulta;
		if (!r.ok) throw new HubError(r.code, r.status, r.details);
		return r.resultados.map(aResultSet);
	};
	return {
		async execute(entrada: SentenciaDelHub, args?: unknown[]) {
			const s = typeof entrada === "string" && args ? { sql: entrada, args } : entrada;
			return (await pedir([s], false))[0];
		},
		async batch(sentencias: SentenciaDelHub[]) {
			return pedir(sentencias, true);
		},
		transaction: sinTransacciones,
		executeMultiple: sinTransacciones,
		migrate: sinTransacciones,
		sync: async () => undefined,
		close() {},
		closed: false,
		protocol: "do",
	} as unknown as Client;
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

/** Ejecuta una lectura contra la base del negocio. */
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
	return fn(clienteDelHub(env, tenantId));
}
