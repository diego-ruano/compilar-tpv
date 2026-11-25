// test/cargaDeCopias.test.ts
//
// El cargador que comparten las copias de la base de cada negocio y de la central
// (`durableObjects/cargaDeCopias.ts`), con líneas escritas a mano sobre una tabla de prueba. La ida y
// vuelta con copias de verdad está en `copiaBaseCentral.test.ts` y `copiasDeNegocios.test.ts`; aquí,
// lo que esas copias casi nunca traen:
//
//   · una línea que no cabe en una llamada (100 KB) va con sus textos como argumentos, y sale igual
//     que si se ejecutara tal cual: los textos con saltos de línea, cada uno en su sitio, y los
//     números con su tipo (enlazado, un número entra como REAL);
//   · una línea con más saltos escritos con `char(10)` de los que admite el SQLite de un objeto en
//     una expresión (100 niveles) también, aunque sea corta;
//   · una línea que SQLite no acepta dice en qué líneas de la copia y de qué tabla, sin su contenido.

import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { cargarCopia } from "../src/durableObjects/cargaDeCopias";
import { literalEnUnaLinea } from "../src/durableObjects/volcadoSql";
import { centralSinAprovisionar } from "./helpers/central";

/** La tabla de prueba: `a` y `c` sin tipo, que guardan cada valor con el tipo con el que llega. */
const TABLA = "CREATE TABLE t (id INTEGER PRIMARY KEY, a, b TEXT, c, d TEXT, e BLOB);";

/** Lo que se lee de la tabla: cada valor con su tipo. */
const LEER = `SELECT id, a, typeof(a) AS ta, b, c, typeof(c) AS tc, length(d) AS ld, substr(d, -2) AS fd, quote(e) AS e FROM t ORDER BY id;`;

/** Una línea de datos de la tabla de prueba, con sus valores ya escritos como literales. */
const linea = (...valores: string[]) => `INSERT INTO "t" ("id", "a", "b", "c", "d", "e") VALUES (${valores.join(", ")});`;

/** Un texto escrito con `char(10)` y `char(13)` en cada salto, tenga los que tenga. */
function conChar(texto: string): string {
	const escapado = `'${texto.replaceAll("'", "''")}'`;
	return `(${escapado.replaceAll("\n", "'||char(10)||'").replaceAll("\r", "'||char(13)||'")})`;
}

/**
 * Carga `datos` como una copia en un objeto nuevo, con la tabla de prueba. Devuelve lo cargado y lo
 * que hay en la tabla, o el mensaje con el que ha fallado.
 */
async function cargar(datos: string[]) {
	const { stub } = centralSinAprovisionar();
	return runInDurableObject(stub, async (_objeto, state) => {
		async function* lineas() {
			yield "-- Copia de prueba";
			yield "-- Migraciones: m1";
			yield TABLA;
			yield* datos;
			yield `-- Fin de la copia: ${datos.length} filas en 1 tablas`;
		}
		try {
			const cargada = await cargarCopia(state.storage, lineas(), {
				migraciones: ["m1"],
				esTablaDeLaCopia: (t) => t === "t",
				prepararBase: async () => {
					state.storage.sql.exec(TABLA);
				},
			});
			return { cargada, filas: state.storage.sql.exec(LEER).toArray() };
		} catch (error) {
			return { error: String((error as Error).message) };
		}
	});
}

describe("el cargador de las copias", () => {
	it("una línea que no cabe en una llamada sale igual que si se ejecutara tal cual", async () => {
		const largo = "x".repeat(40_000);
		const r = await cargar([
			linea("1", "5", literalEnUnaLinea("uno\r\ndos\rtres\ncuatro"), "1.5", literalEnUnaLinea(largo), "X'00ff'"),
			linea("2", "-3", literalEnUnaLinea("con\0nulo"), "NULL", literalEnUnaLinea(largo + "'"), "NULL"),
			// Y la misma, corta: va tal cual, con las demás.
			linea("3", "5", literalEnUnaLinea("uno\r\ndos\rtres\ncuatro"), "1.5", "'corto'", "X'00ff'"),
		]);
		expect(r).toEqual({
			cargada: { filas: 3, tablas: 1 },
			filas: [
				{ id: 1, a: 5, ta: "integer", b: "uno\r\ndos\rtres\ncuatro", c: 1.5, tc: "real", ld: 40_000, fd: "xx", e: "X'00FF'" },
				{ id: 2, a: -3, ta: "integer", b: "con\0nulo", c: null, tc: "null", ld: 40_001, fd: "x'", e: "NULL" },
				{ id: 3, a: 5, ta: "integer", b: "uno\r\ndos\rtres\ncuatro", c: 1.5, tc: "real", ld: 5, fd: "to", e: "X'00FF'" },
			],
		});
	});

	it("una línea corta con más saltos escritos con char(10) de los que admite una expresión también se carga", async () => {
		const texto = Array.from({ length: 120 }, (_, i) => (i % 2 ? `línea ${i}\r` : `línea ${i}\n`)).join("") + "fin";
		const datos = linea("1", "1", conChar(texto), "NULL", conChar("a\nb"), "NULL");
		expect(datos.length).toBeLessThan(10_000);
		const r = await cargar([datos]);
		// Que el texto ha vuelto entero se compara aquí, y no en el `toMatchObject`, que lo pintaría entero al fallar.
		const { filas, ...resto } = r as { filas?: { b: string; ld: number }[] };
		expect(resto).toEqual({ cargada: { filas: 1, tablas: 1 } });
		expect(filas?.map((f) => [f.b === texto, f.ld])).toEqual([[true, 3]]);
	});

	it("una línea que SQLite no acepta dice en qué líneas de la copia y de qué tabla, sin su contenido", async () => {
		const r = await cargar([
			linea("1", "1", "'bien'", "NULL", "NULL", "NULL"),
			linea("2", "1", "'Ana Gil Sanz, ana.gil@correo.es", "NULL", "NULL", "NULL"),
		]);
		expect(r).toEqual({ error: expect.stringMatching(/^SQLite no acepta una de las líneas 4–5 de la copia \(t\): SQLITE_ERROR$/) });
	});
});
