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
	/** Una lectura de la central: las columnas en su orden y las filas como objetos. */
	leer: (sql: string) => Promise<{ columnas: string[]; filas: Record<string, unknown>[] }>;
};

/** Las tablas que tiene ya el SQLite del objeto. */
function tablasDe(sql: SqlStorage): string[] {
	return sql
		.exec(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;`)
		.toArray()
		.map((fila) => String(fila.name));
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

		clienteActual = clienteSobre(sql, hub.state.storage);
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
			});
		} finally {
			clienteActual = null;
		}
	});
}
