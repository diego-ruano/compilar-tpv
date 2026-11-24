// src/lib/tenantClient.ts
//
// El cliente de la base de cada negocio para las LECTURAS de la API.
//
// La base vive en el SQLite del TenantHub del negocio, y toda ruta que la lee se ejecuta dentro de él
// (`lib/enElHub.ts`): `tenantQuery` le da a la ruta la base de al lado (`tenantHub.sqlite.ts`), una
// `Base` de `lib/sql.ts` (`execute`, `batch`). Fuera del TenantHub no hay de dónde leer: una ruta que
// llamara a `tenantQuery` sin `alHub` en su router falla en el acto. La agenda de reservas web y la
// API pública de la reserva, que no corren dentro, leen por `leerParaLaWeb`
// (`domains/reservas_web/lecturasDeLaWeb.ts`), una lectura entera por viaje.
//
// - Una escritura del negocio va por el motor del DO (`lib/hub.ts`), que es quien la apunta y la
//   difunde. Lo único que una ruta escribe por aquí es el estado propio de la nube (el freno del PIN,
//   el checkpoint de la purga, el resumen diario de las estadísticas), que no se replica.
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

import type { Base, Sentencia } from "./sql";

import type { Env } from "../env";
import { hubLocal } from "./hubLocal";
import { parseClientNow, rewriteNowInSql } from "../durableObjects/tenantHub.tiempo";

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

/**
 * REV-03: la misma base, pero resolviendo «ahora» a la hora local de quien pregunta.
 *
 * Una `Base` tiene dos puertas por las que sale SQL, `execute` y `batch`, y las dos fijan la hora.
 * No hay una tercera: si alguna lectura necesitara otra (una transacción interactiva, por ejemplo),
 * tendría que fijarla también, o su SQL saldría con el día del servidor sin que nadie lo notara.
 */
export function conLaHoraDeQuienPregunta(db: Base, ahoraLocal: string): Base {
	const reescribir = (stmt: Sentencia): Sentencia =>
		typeof stmt === "string"
			? rewriteNowInSql(stmt, ahoraLocal)
			: { ...stmt, sql: rewriteNowInSql(stmt.sql, ahoraLocal) };

	return {
		execute: (stmt) => db.execute(reescribir(stmt)),
		batch: (stmts) => db.batch(stmts.map(reescribir)),
	};
}

/**
 * Ejecuta una lectura contra la base del negocio, desde una ruta que se ejecuta en su TenantHub.
 *
 * Fuera de él lanza: es un router sin `alHub` que lee la base del negocio, y lo que le toca es
 * llevarlo (`lib/enElHub.ts`). Un test que monta un router suelto pone su propio `tenantQuery`.
 */
export async function tenantQuery<T>(
	c: ContextoDeLectura,
	fn: (db: Base) => Promise<T>,
): Promise<T> {
	const local = hubLocal(c.get("tenantId"));
	if (!local) {
		throw new Error("tenantQuery: la ruta no se está ejecutando en el TenantHub de su negocio (¿falta alHub en su router?)");
	}
	const db = await local.base();
	// REV-03: la hora local del emisor, validada igual que en las escrituras (formato y deriva).
	const ahoraLocal = parseClientNow(c.req.header("X-Client-Now"));
	return fn(ahoraLocal ? conLaHoraDeQuienPregunta(db, ahoraLocal) : db);
}
