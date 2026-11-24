// test/oraculo/montaje.ts
//
// Dónde vive la base central del oráculo (`test/oraculoCentral.test.ts`) y cómo llegan a ella las
// rutas. Es la ÚNICA pieza del oráculo que sabe cómo está montada la central: cuando la central pase
// a su Durable Object, se sustituye este fichero por uno que la monte de verdad, y los escenarios,
// el arnés (`escenario.ts`) y la normalización (`normalizar.ts`) no cambian ni una línea.
//
// Hoy la central es una base de Turso a la que las rutas llegan con `getDb` (`src/server/db.ts`).
// Aquí `getDb` devuelve un cliente servido por el SQLite de un Durable Object de pruebas
// (`helpers/clienteSql.ts`) con el esquema de producción (`helpers/planoDeControl.ts`): el mismo SQL
// de las rutas contra la misma estructura, sin salir a la red.
//
// Las fotos de `test/oraculo/central/` salen de ese doble, no de Turso, y el doble no es libsql en
// tres cosas: los valores se enlazan como los enlaza el SqlStorage de workerd; `rowsAffected` es el
// `rowsWritten` del cursor, que cuenta también lo escrito en los índices (las rutas de estos
// escenarios sólo lo comparan con 0); y una transacción que se deshace devuelve las tablas a su foto
// borrando y reinsertando sus filas (en estos escenarios no se deshace ninguna). Una diferencia que
// venga de una de esas tres cosas se contrasta con lo que hace libsql antes de dar la foto por mala.

import { vi } from "vitest";

import { clienteSobre } from "../helpers/clienteSql";
import { enElHub } from "../helpers/hub";
import { prepararPlanoDeControl } from "../helpers/planoDeControl";

/** El cliente de la central del escenario en curso; lo devuelve el `getDb` sustituido. */
let clienteActual: unknown = null;

vi.mock("../../src/server/db", async (original) => ({
	...(await original<typeof import("../../src/server/db")>()),
	getDb: () => {
		if (!clienteActual) throw new Error("El oráculo ha llegado a la central fuera de un escenario.");
		return clienteActual;
	},
}));

/** Lo que el oráculo necesita de la central de un escenario. */
export type Central = {
	/** Lo que el `Env` de las rutas tiene que llevar para llegar a esta central. */
	entorno: Record<string, unknown>;
	/** Las tablas de la central: las de su esquema, sin las internas del objeto que la guarda. */
	tablas: readonly string[];
	/**
	 * Una lectura de la central, por fuera de las rutas: las columnas en su orden y las filas como
	 * objetos. Tiene que admitir `rowid` y `pragma_table_info`.
	 */
	leer: (sql: string) => Promise<{ columnas: string[]; filas: Record<string, unknown>[] }>;
	/**
	 * Cuántos accesos de las rutas a la central han terminado hasta ahora (cada sentencia, lote o
	 * paso de una transacción; las lecturas de `leer` no cuentan). El arnés lo mira al responder y
	 * después de lo que queda en segundo plano: lo que termina entre las dos no estaba hecho al
	 * contestar.
	 */
	accesos: () => number;
};

/** Las tablas que tiene ya el SQLite del objeto. */
function tablasDe(sql: SqlStorage): string[] {
	return sql
		.exec(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;`)
		.toArray()
		.map((fila) => String(fila.name));
}

const unaVuelta = () => new Promise<void>((seguir) => setTimeout(seguir, 0));

/**
 * El cliente de `clienteSobre`, con la central a una vuelta del bucle de eventos y avisando cada vez
 * que termina un acceso (`Central.accesos`).
 *
 * `clienteSobre` contesta en el acto, y la central de verdad está al otro lado de la red: sin la
 * vuelta, un acceso que una ruta deja en `waitUntil` terminaría antes de que la app devolviera la
 * respuesta, y no se vería que no estaba hecho al contestar.
 */
function contandoAccesos(cliente: any, alTerminar: () => void) {
	const acceso = async <T>(hacer: () => Promise<T>): Promise<T> => {
		await unaVuelta();
		try {
			return await hacer();
		} finally {
			alTerminar();
		}
	};
	return {
		execute: (sentencia: unknown) => acceso(() => cliente.execute(sentencia)),
		batch: (sentencias: unknown[], modo?: string) => acceso(() => cliente.batch(sentencias, modo)),
		async transaction(modo?: string) {
			const tx = await acceso<any>(() => cliente.transaction(modo));
			return {
				execute: (sentencia: unknown) => acceso(() => tx.execute(sentencia)),
				commit: () => acceso(() => tx.commit()),
				rollback: () => acceso(() => tx.rollback()),
				close: () => tx.close(),
			};
		},
	};
}

/**
 * Corre `fn` con una central vacía y propia del escenario: el SQLite de un `TenantHub` de pruebas
 * llamado como el escenario, con el esquema de producción recién creado.
 */
export async function conLaCentral<T>(escenario: string, fn: (central: Central) => Promise<T>): Promise<T> {
	return enElHub(`oraculo-central-${escenario}`, async (hub: any) => {
		const sql: SqlStorage = hub.state.storage.sql;
		const antes = tablasDe(sql);
		if (antes.includes("licenses")) {
			throw new Error(`La central del escenario «${escenario}» no está vacía: cada escenario necesita un nombre propio.`);
		}
		prepararPlanoDeControl(sql);
		const tablas = tablasDe(sql).filter((tabla) => !antes.includes(tabla));

		let accesos = 0;
		clienteActual = contandoAccesos(clienteSobre(sql, hub.state.storage), () => accesos++);
		try {
			return await fn({
				// `assertEnv` de las rutas exige que estén; el cliente sustituido no las usa.
				entorno: {
					TURSO_DATABASE_URL: "libsql://central-del-oraculo.invalid",
					TURSO_AUTH_TOKEN: "token-del-oraculo",
				},
				tablas,
				async leer(texto) {
					const cursor = sql.exec(texto);
					const columnas = [...cursor.columnNames];
					return { columnas, filas: cursor.toArray() as Record<string, unknown>[] };
				},
				accesos: () => accesos,
			});
		} finally {
			clienteActual = null;
		}
	});
}
