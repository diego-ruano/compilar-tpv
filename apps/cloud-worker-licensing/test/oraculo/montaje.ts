// test/oraculo/montaje.ts
//
// Dónde vive la base central del oráculo (`test/oraculoCentral.test.ts`) y cómo llegan a ella las
// rutas. Es la ÚNICA pieza del oráculo que sabe cómo está montada la central: los escenarios, el arnés
// (`escenario.ts`) y la normalización (`normalizar.ts`) no saben nada de ella.
//
// La central de cada escenario es un objeto `BaseCentral` de verdad, propio del escenario y recién
// aprovisionado (`helpers/central.ts`). Las rutas llegan a él como en producción: `getDb(env)` pide
// la central con `centralDe(env)`, y el `env` del escenario lleva un `BaseCentral` que da ese objeto
// sea cual sea el nombre que se le pida. Lo que se lee para la foto se lee por fuera del objeto, en
// su SQLite (`runInDurableObject`), sin pasar por sus guardas ni contar como acceso.

import { env, runInDurableObject } from "cloudflare:test";
import { vi } from "vitest";

import { centralDePrueba, interceptar } from "../helpers/central";

// Cada paso lee la central entera, tabla a tabla, y cada lectura es un viaje al objeto: un escenario
// largo tarda menos de un segundo solo, pero con la suite entera corriendo a la vez puede pasar de
// los 5 s por defecto. Un escenario cortado a medias seguiría moviendo el reloj simulado del
// siguiente.
vi.setConfig({ testTimeout: 60_000 });

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
	 * Cuántos accesos de las rutas a la central han terminado hasta ahora (cada llamada al objeto:
	 * una sentencia, un lote o una operación; las lecturas de `leer` no cuentan). El arnés lo mira al
	 * responder y después de lo que queda en segundo plano: lo que termina entre las dos no estaba
	 * hecho al contestar.
	 */
	accesos: () => number;
};

/** Corre `fn` con una central vacía, aprovisionada y propia del escenario. */
export async function conLaCentral<T>(escenario: string, fn: (central: Central) => Promise<T>): Promise<T> {
	const nombre = `oraculo-central-${escenario}`;
	const { stub } = await centralDePrueba(nombre);

	const leer: Central["leer"] = (texto) =>
		runInDurableObject(stub, (_objeto, state) => {
			const cursor = state.storage.sql.exec(texto);
			const filas = cursor.toArray() as Record<string, unknown>[];
			return { columnas: [...cursor.columnNames], filas };
		});

	const { filas: lasTablas } = await leer(
		`SELECT name FROM sqlite_master
		  WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
		    AND name <> '_migrations'
		  ORDER BY name;`,
	);
	const tablas = lasTablas.map((f) => String(f.name));
	const { filas: conFilas } = await leer(`SELECT COUNT(*) AS n FROM licenses;`);
	if (Number(conFilas[0].n) > 0) {
		throw new Error(`La central del escenario «${escenario}» no está vacía: cada escenario necesita un nombre propio.`);
	}

	// Cada llamada de las rutas al objeto cuenta cuando termina.
	let accesos = 0;
	const id = env.BaseCentral.idFromName(nombre);
	const espacio = {
		idFromName: () => id,
		get: () =>
			interceptar(env.BaseCentral.get(id), async (_metodo, _argumentos, llamar) => {
				try {
					return await llamar();
				} finally {
					accesos++;
				}
			}),
	};

	return fn({
		entorno: { BaseCentral: espacio },
		tablas,
		leer,
		accesos: () => accesos,
	});
}
