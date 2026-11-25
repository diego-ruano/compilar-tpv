// test/cargaDeCopias.test.ts
//
// El cargador que comparten las copias de la base de cada negocio y de la central
// (`durableObjects/cargaDeCopias.ts`), con líneas escritas a mano sobre una tabla de prueba. La ida y
// vuelta con copias de verdad está en `copiaBaseCentral.test.ts` y `copiasDeNegocios.test.ts`; aquí,
// lo que esas copias casi nunca traen:
//
//   · cada literal que ha escrito alguna vez una copia vuelve igual, con su tipo, que si SQLite
//     ejecutara su línea: en una fila corta, que va con otras en una llamada, y en una que no cabe en
//     una llamada (100 KB), que va con sus textos como argumentos. También los textos con más saltos
//     escritos con `char(10)` de los que admite el SQLite de un objeto en una expresión;
//   · una línea de datos que no es exactamente una fila (otra sentencia detrás, un comentario, una
//     función, una subconsulta, varias filas, una columna que no es de la tabla, un número que SQLite
//     guardaría como infinito…) hace inservible la copia: dice en qué línea y carácter y por qué, sin
//     nada de lo que lleva, y no se ejecuta nada;
//   · una fila que SQLite no acepta dice en qué líneas de la copia y de qué tabla, sin su contenido;
//   · las líneas del gzip (`lineasDe`): la de la fila más grande que admite un objeto en producción,
//     como la escribe hoy la copia, sale entera, y una más larga que el tope hace inservible la copia
//     en cuanto se pasa, sin esperar a su final. También la de una copia de un negocio de antes, con
//     cada salto escrito con `char(10)`, si una fila lleva más de 1,27 millones: no se restaura.

import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { CARACTERES_POR_LINEA, cargarCopia, lineasDe } from "../src/durableObjects/cargaDeCopias";
import { literalEnUnaLinea, PRINCIPIO_DE_INSERT } from "../src/durableObjects/volcadoSql";
import { centralSinAprovisionar } from "./helpers/central";

/** La tabla de prueba: `a` y `c` sin tipo, que guardan cada valor con el tipo con el que llega. */
const TABLA = "CREATE TABLE t (id INTEGER PRIMARY KEY, a, b TEXT, c, d TEXT, e BLOB);";

/** Lo que se lee de la tabla: cada valor con su tipo. */
const LEER = `SELECT id, a, typeof(a) AS ta, b, c, typeof(c) AS tc, length(d) AS ld, substr(d, -2) AS fd, quote(e) AS e FROM t ORDER BY id;`;

/** Una línea de datos de la tabla de prueba, con sus valores ya escritos como literales. */
const linea = (...valores: string[]) => `INSERT INTO "t" ("id", "a", "b", "c", "d", "e") VALUES (${valores.join(", ")});`;

/** Un texto escrito con `char(10)` y `char(13)` en cada salto, tenga los que tenga, como la copia de un negocio antes. */
function conChar(texto: string): string {
	const escapado = `'${texto.replaceAll("'", "''")}'`;
	return `(${escapado.replaceAll("\n", "'||char(10)||'").replaceAll("\r", "'||char(13)||'")})`;
}

/** Las líneas de una copia de prueba con `datos` detrás de la cabecera y el esquema: el primero es la línea 4. */
async function* copiaCon(datos: string[]) {
	yield "-- Copia de prueba";
	yield "-- Migraciones: m1";
	yield TABLA;
	yield* datos;
	yield `-- Fin de la copia: ${datos.length} filas en 1 tablas`;
}

/** Carga la copia de `datos` en la base de `state`, con la tabla de prueba. */
function cargarEn(state: DurableObjectState, datos: string[]) {
	return cargarCopia(state.storage, copiaCon(datos), {
		migraciones: ["m1"],
		esTablaDeLaCopia: (t) => t === "t",
		prepararBase: async () => {
			state.storage.sql.exec(TABLA);
		},
	});
}

/**
 * Carga `datos` como una copia en un objeto nuevo, con la tabla de prueba. Devuelve lo cargado y lo
 * que hay en la tabla, o el mensaje con el que ha fallado, las tablas que hay y las filas de `t`.
 */
async function cargar(datos: string[]) {
	const { stub } = centralSinAprovisionar();
	return runInDurableObject(stub, async (_objeto, state) => {
		const sql = state.storage.sql;
		try {
			const cargada = await cargarEn(state, datos);
			return { cargada, filas: sql.exec(LEER).toArray() };
		} catch (error) {
			return {
				error: String((error as Error).message),
				tablas: sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name;").toArray().map((f) => f.name),
				enT: sql.exec("SELECT count(*) AS n FROM t;").one().n,
			};
		}
	});
}

describe("el cargador de las copias", () => {
	it("una línea que no cabe en una llamada sale igual que si se ejecutara tal cual", async () => {
		const largo = "x".repeat(40_000);
		const r = await cargar([
			linea("1", "5", literalEnUnaLinea("uno\r\ndos\rtres\ncuatro"), "1.5", literalEnUnaLinea(largo), "X'00ff'"),
			linea("2", "-3", literalEnUnaLinea("con\0nulo"), "NULL", literalEnUnaLinea(largo + "'"), "NULL"),
			// Y la misma, corta: va con las demás.
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

	it("una fila que SQLite no acepta dice en qué líneas de la copia y de qué tabla, sin su contenido", async () => {
		const r = await cargar([
			linea("1", "1", "'bien'", "NULL", "NULL", "NULL"),
			linea("1", "1", "'Ana Gil Sanz, ana.gil@correo.es'", "NULL", "NULL", "NULL"),
		]);
		expect(r).toMatchObject({ error: expect.stringMatching(/^SQLite no acepta una de las líneas 4–5 de la copia \(t\): SQLITE_CONSTRAINT$/) });
	});
});

describe("lo que ha escrito alguna vez una copia vuelve igual, con su tipo", () => {
	/**
	 * Cada literal en la columna sin tipo `a`, dos veces: en una fila corta y en una que no cabe en una
	 * llamada. Y lo que deja SQLite ejecutándolo tal cual, en otra tabla igual, cuando puede (con muchos
	 * saltos escritos con `char(…)` no: la expresión es demasiado honda).
	 */
	async function idaYVuelta(literales: string[]) {
		const { stub } = centralSinAprovisionar();
		return runInDurableObject(stub, async (_objeto, state) => {
			const sql = state.storage.sql;
			const largo = `'${"x".repeat(40_000)}'`;
			await cargarEn(
				state,
				literales.flatMap((lit, k) => [
					`INSERT INTO "t" ("id", "a") VALUES (${2 * k}, ${lit});`,
					`INSERT INTO "t" ("id", "a", "d") VALUES (${2 * k + 1}, ${lit}, ${largo});`,
				]),
			);
			const leer = (tabla: string) =>
				sql
					.exec(
						`SELECT id, typeof(a) AS tipo, hex(a) AS bytes, CASE WHEN typeof(a) IN ('integer', 'real') THEN a END AS numero
						 FROM ${tabla} ORDER BY id;`,
					)
					.toArray();
			const cargadas = leer("t");
			sql.exec("CREATE TABLE o (id INTEGER PRIMARY KEY, a);");
			for (const [k, lit] of literales.entries()) {
				try {
					sql.exec(`INSERT INTO o (id, a) VALUES (${k}, ${lit});`);
				} catch {
					// Más honda de lo que admite el SQLite de un objeto: se compara con lo que tiene que ser.
				}
			}
			return { cargadas, directas: leer("o") };
		});
	}

	const hexDe = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();

	it("cada literal, en una fila que va con otras y en una que va sola con argumentos", async () => {
		const valores: SqlStorageValue[] = [
			null,
			0, -3, 7, 1790000000123, 9007199254740991, -9007199254740991, 2 ** 53 + 2,
			1e21, -1e21, 1e300, 1.5, -0.25, 0.1, 1e-7, -1.2345678901234566e-7, 5e-324, 1.7976931348623157e308, -1.7976931348623157e308, 12.5,
			"", "x", "a'b", "''", "Café ☕ 🍺 «Ñandú»", "-- no es un comentario", "/* tampoco */", "'); DELETE FROM t; --",
			"a||char(10)||b", "||char(13)||", "\uFEFFcon BOM delante",
			"uno\r\ndos\rtres\ncuatro", "\n", "\r", "\r\n", "fin\n", "\nprincipio", "a\n\nb", "x\n".repeat(40) + "y",
			"con\0nulo", "\0", "\uFEFF\0con BOM y un NUL", "x\n".repeat(41) + "y",
			new ArrayBuffer(0), new Uint8Array([0, 255, 16, 0x27]).buffer,
		];
		/** Lo que no ha escrito `literalEnUnaLinea` de hoy, y sí alguna copia. */
		const deAntes = [
			// La de un negocio, antes de `SALTOS_CON_CHAR`: todos los saltos con `char(…)`.
			conChar("x\n".repeat(60) + "y"),
			conChar("a\r\n".repeat(45) + "b"),
			// El traspaso desde Turso: un REAL entero con su `.0`, y los enteros de SQLite enteros.
			"5.0", "-3.0", "0.0", "9223372036854775807", "-9223372036854775808", "12345678901234567890",
			// Unos bytes en mayúsculas, que SQLite lee igual.
			"X'00FF'",
		];
		const literales = [...valores.map(literalEnUnaLinea), ...deAntes];
		/** Lo que tiene que dejar un literal que SQLite no puede ejecutar tal cual. */
		const sinDirecta = new Map([
			[literales.length - 9, "x\n".repeat(60) + "y"],
			[literales.length - 8, "a\r\n".repeat(45) + "b"],
		]);

		const { cargadas, directas } = await idaYVuelta(literales);
		expect(cargadas).toHaveLength(2 * literales.length);
		const comoDirecta = new Map(directas.map(({ id, ...resto }) => [Number(id), resto]));
		expect(comoDirecta.size).toBe(literales.length - sinDirecta.size);
		for (const [k, lit] of literales.entries()) {
			const texto = sinDirecta.get(k);
			const esperado =
				texto === undefined
					? comoDirecta.get(k)
					: { tipo: "text", bytes: hexDe(new TextEncoder().encode(texto)), numero: null };
			// El literal sale en el mensaje sólo hasta 80 caracteres: los hay de 40.000.
			const que = `${k}: ${lit.slice(0, 80)}`;
			const { id: corta, ...enLaCorta } = cargadas[2 * k];
			const { id: larga, ...enLaLarga } = cargadas[2 * k + 1];
			expect([corta, larga], que).toEqual([2 * k, 2 * k + 1]);
			expect(enLaCorta, que).toEqual(esperado);
			expect(enLaLarga, que).toEqual(esperado);
		}
	});
});

describe("una línea de datos que no es exactamente una fila hace inservible la copia, y no se ejecuta nada", () => {
	/** Lo que no puede salir en el motivo: es de la copia, y el motivo va al log y a Axiom. */
	const DE_LA_COPIA = "ana.gil@correo.es";
	const BUENA = linea("1", "1", "'bien'", "NULL", "NULL", "NULL");
	/** Una fila de la tabla de prueba que sí vale, con lo de la copia dentro, delante de lo que se le añade. */
	const fila = (...valores: string[]) => linea("2", ...valores);
	const conDatos = fila("2", `'${DE_LA_COPIA}'`, "NULL", "NULL", "NULL");

	/** Qué tiene la línea, la línea, el motivo, y dónde lo encuentra: el carácter donde empieza esto. */
	const casos: [string, string, string, string][] = [
		["otra sentencia detrás", `${conDatos} DELETE FROM t;`, "sobra_texto", " DELETE"],
		["otra sentencia pegada", `${conDatos}DELETE FROM t;`, "sobra_texto", "DELETE"],
		["un DDL detrás", `${conDatos} DROP TABLE t;`, "sobra_texto", " DROP"],
		["una tabla nueva detrás", `${conDatos} CREATE TABLE u (a);`, "sobra_texto", " CREATE"],
		["un PRAGMA detrás", `${conDatos} PRAGMA foreign_keys = ON;`, "sobra_texto", " PRAGMA"],
		["un ATTACH detrás", `${conDatos} ATTACH DATABASE 'otra.db' AS otra;`, "sobra_texto", " ATTACH"],
		["un comentario detrás", `${conDatos} -- ${DE_LA_COPIA}`, "sobra_texto", " --"],
		["un comentario de bloque detrás", `${conDatos}/* ${DE_LA_COPIA} */`, "sobra_texto", "/*"],
		["una subconsulta", fila("(SELECT count(*) FROM t)", `'${DE_LA_COPIA}'`, "NULL", "NULL", "NULL"), "valor_no_literal", "(SELECT"],
		[
			"una subconsulta entre los trozos de un texto",
			fila("1", `('${DE_LA_COPIA}'||(SELECT name FROM sqlite_master)||'b')`, "NULL", "NULL", "NULL"),
			"valor_no_literal",
			`('${DE_LA_COPIA}'`,
		],
		["un salto que no es char(10) ni char(13)", fila("1", `('${DE_LA_COPIA}'||char(9)||'b')`, "NULL", "NULL", "NULL"), "valor_no_literal", `('`],
		["un texto entre paréntesis sin saltos", fila("1", `('${DE_LA_COPIA}')`, "NULL", "NULL", "NULL"), "valor_no_literal", `('`],
		["una función", fila("1", `upper('${DE_LA_COPIA}')`, "NULL", "NULL", "NULL"), "valor_no_literal", "upper"],
		["randomblob", fila("1", "NULL", "NULL", "NULL", "randomblob(4)"), "valor_no_literal", "randomblob"],
		["una expresión", fila("1 + 1", `'${DE_LA_COPIA}'`, "NULL", "NULL", "NULL"), "valor_no_literal", "1 + 1"],
		["dos textos unidos", fila("1", `'${DE_LA_COPIA}' || 'b'`, "NULL", "NULL", "NULL"), "valor_no_literal", `'${DE_LA_COPIA}'`],
		["NULLIF", fila("NULLIF(1, 1)", `'${DE_LA_COPIA}'`, "NULL", "NULL", "NULL"), "valor_no_literal", "NULLIF"],
		["un número en hexadecimal", fila("0x10", `'${DE_LA_COPIA}'`, "NULL", "NULL", "NULL"), "valor_no_literal", "0x10"],
		["un número con +", fila("+1", `'${DE_LA_COPIA}'`, "NULL", "NULL", "NULL"), "valor_no_literal", "+1"],
		["un exponente sin signo", fila("1e5", `'${DE_LA_COPIA}'`, "NULL", "NULL", "NULL"), "valor_no_literal", "1e5"],
		// SQLite los guardaría como infinito, que ninguna copia escribe y con el que la base ya no se puede copiar.
		["un número que no cabe en un REAL", fila("1e+999", `'${DE_LA_COPIA}'`, "NULL", "NULL", "NULL"), "valor_no_literal", "1e+999"],
		["uno negativo que no cabe", fila("-1e+999", `'${DE_LA_COPIA}'`, "NULL", "NULL", "NULL"), "valor_no_literal", "-1e+999"],
		["uno que pasa justo del REAL más grande", fila("1.7976931348623159e+308", `'${DE_LA_COPIA}'`, "NULL", "NULL", "NULL"), "valor_no_literal", "1.7976931348623159e+308"],
		["un entero de 401 cifras", fila(`1${"0".repeat(400)}`, `'${DE_LA_COPIA}'`, "NULL", "NULL", "NULL"), "valor_no_literal", `1${"0".repeat(400)}`],
		["unos bytes que no son hexadecimal", fila("1", `'${DE_LA_COPIA}'`, "NULL", "NULL", "X'0g'"), "valor_no_literal", "X'0g'"],
		["unos bytes a medias", fila("1", `'${DE_LA_COPIA}'`, "NULL", "NULL", "X'abc'"), "valor_no_literal", "X'abc'"],
		["un texto en hexadecimal que no es UTF-8", fila("1", "CAST(X'ff' AS TEXT)", `'${DE_LA_COPIA}'`, "NULL", "NULL"), "valor_no_literal", "CAST"],
		["unos bytes convertidos a otra cosa", fila("1", "CAST(X'61' AS BLOB)", `'${DE_LA_COPIA}'`, "NULL", "NULL"), "valor_no_literal", "CAST"],
		["un texto sin cerrar", fila("1", `'${DE_LA_COPIA}`, "NULL", "NULL", "NULL"), "valor_no_literal", `'${DE_LA_COPIA}`],
		["varias filas", `INSERT INTO "t" ("id", "a") VALUES (2, '${DE_LA_COPIA}'), (3, 'y');`, "fila_mal_formada", ", (3"],
		["un espacio de menos entre valores", `INSERT INTO "t" ("id", "a") VALUES (2,'${DE_LA_COPIA}');`, "fila_mal_formada", ",'"],
		["un espacio de más", `INSERT INTO "t"  ("id", "a") VALUES (2, '${DE_LA_COPIA}');`, "fila_mal_formada", "  ("],
		["un nombre sin cerrar", `INSERT INTO "t" ("id", "a) VALUES (2, '${DE_LA_COPIA}');`, "fila_mal_formada", '"a)'],
		["una columna que no es de la tabla", `INSERT INTO "t" ("id", "zz") VALUES (2, '${DE_LA_COPIA}');`, "columna_desconocida", '"zz"'],
		["una columna repetida", `INSERT INTO "t" ("id", "a", "A") VALUES (2, 1, '${DE_LA_COPIA}');`, "columna_repetida", '"A"'],
		["una tabla que la copia no puede traer", `INSERT INTO "sqlite_master" ("name") VALUES ('${DE_LA_COPIA}');`, "tabla_ajena", '"sqlite_master"'],
		["menos valores que columnas", `INSERT INTO "t" ("id", "a", "b") VALUES (2, '${DE_LA_COPIA}');`, "valores_no_casan", ");"],
	];

	it.each(casos)("%s", async (_que, mala, motivo, donde) => {
		expect(mala.indexOf(donde), "dónde").toBeGreaterThan(0);
		const r = await cargar([BUENA, mala]);
		// El motivo entero: la línea, el carácter y el código, y nada más.
		expect(r).toEqual({
			error: `copia_no_valida: la línea 5 no se puede cargar: ${motivo} (carácter ${mala.indexOf(donde) + 1})`,
			tablas: ["t"],
			enT: 0,
		});
	});

	it("tampoco en una línea que no cabe en una llamada", async () => {
		const larga = `${linea("2", "1", `'${"x".repeat(40_000)}'`, "NULL", "NULL", "NULL")} DELETE FROM t;`;
		expect(await cargar([BUENA, larga])).toEqual({
			error: `copia_no_valida: la línea 5 no se puede cargar: sobra_texto (carácter ${larga.indexOf(" DELETE") + 1})`,
			tablas: ["t"],
			enT: 0,
		});
	});
});

describe("las líneas de una copia (lineasDe)", () => {
	/** `texto`, comprimido con gzip, como llega de R2. */
	const gzipDe = (texto: string) => new Blob([texto]).stream().pipeThrough(new CompressionStream("gzip"));

	/** Las líneas que da `lineasDe`, o el mensaje con el que se para y las que ha dado antes. */
	async function leer(cuerpo: ReadableStream<Uint8Array>, tope?: number) {
		const dadas: string[] = [];
		try {
			for await (const linea of lineasDe(cuerpo, tope)) dadas.push(linea);
			return { dadas };
		} catch (error) {
			return { dadas, error: String((error as Error).message) };
		}
	}

	it("una línea de hasta el tope sale entera, aunque llegue en muchos trozos; la de un carácter más hace inservible la copia, y dice cuál", async () => {
		const tope = 10_000;
		const justa = "x".repeat(tope);
		expect(await leer(gzipDe(`uno\n${justa}\ndos\n`), tope)).toEqual({ dadas: ["uno", justa, "dos"] });
		expect(await leer(gzipDe(`uno\n${justa}\ndos\n${"y".repeat(tope + 1)}\ntres\n`), tope)).toEqual({
			dadas: ["uno", justa, "dos"],
			error: `copia_no_valida: la línea 4 es demasiado larga: pasa de ${tope} caracteres`,
		});
		// También la última, sin su salto.
		expect(await leer(gzipDe(`uno\n${"y".repeat(tope + 1)}`), tope)).toMatchObject({
			error: `copia_no_valida: la línea 2 es demasiado larga: pasa de ${tope} caracteres`,
		});
	});

	it("una línea que no acaba nunca no se junta: en cuanto pasa del tope se deja de leer, y de pedir la copia", async () => {
		// Un gzip hecho a mano que no se acaba: bloques sin comprimir de 4 KB de «x», ninguno el último.
		// La descompresión del runtime pide lo que llega sin esperar a que se lea, así que, si no se
		// cancela, se lo traga entero; para que el test no se coma la memoria, el origen se rompe a los
		// 64 MiB.
		const pedido = { bytes: 0, cancelado: false };
		const datos = new Uint8Array(4096).fill(0x78);
		let cabecera = true;
		const gzip = new ReadableStream<Uint8Array>({
			pull(c) {
				if (cabecera) {
					cabecera = false;
					return c.enqueue(new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255]));
				}
				if (pedido.bytes >= 64 * 1024 * 1024) return c.error(new Error("el origen se rompe a los 64 MiB"));
				const bloque = new Uint8Array(5 + datos.length);
				bloque.set([0, datos.length & 0xff, datos.length >> 8, ~datos.length & 0xff, (~datos.length >> 8) & 0xff]);
				bloque.set(datos, 5);
				pedido.bytes += datos.length;
				c.enqueue(bloque);
			},
			cancel() {
				pedido.cancelado = true;
			},
		});
		const tope = 256 * 1024;
		expect(await leer(gzip, tope)).toEqual({
			dadas: [],
			error: `copia_no_valida: la línea 1 es demasiado larga: pasa de ${tope} caracteres`,
		});
		await vi.waitFor(() => expect(pedido.cancelado).toBe(true));
		expect(pedido.bytes).toBeLessThan(16 * 1024 * 1024);
	});

	it("la línea de la fila más grande que admite un objeto en producción cabe en el tope, escrita de cualquier forma de las de hoy", async () => {
		// 8 MiB y 34 bytes (`MAX_ROW_LENGTH` de workerd): lo más que ocupa una fila, con todas sus columnas.
		const fila = 8 * 1024 * 1024 + 34;
		const peores: [string, SqlStorageValue][] = [
			["en hexadecimal", "\n".repeat(fila)],
			["unos bytes", new Uint8Array(fila).buffer],
			["comillas dobladas", "'".repeat(fila)],
			["comillas dobladas y los saltos que van con char(10)", "\n".repeat(40) + "'".repeat(fila - 40)],
		];
		// Lo que pueden sumar los nombres y los demás valores de una fila de hasta 100 columnas (lo más
		// que admite una tabla de un objeto): cada nombre con sus comillas, su coma y un número.
		const resto = 100 * (64 + 4 + 24 + 2);
		for (const [que, valor] of peores) {
			const linea = `${PRINCIPIO_DE_INSERT}t" ("a") VALUES (${literalEnUnaLinea(valor)});`;
			expect(linea.length + resto, que).toBeLessThan(CARACTERES_POR_LINEA);
		}
		// Y sale entera por `lineasDe`, con el tope de verdad.
		const copia = ["-- Migraciones: m1", `${PRINCIPIO_DE_INSERT}t" ("a") VALUES (${literalEnUnaLinea(peores[0][1])});`, "-- Fin de la copia: 1 filas en 1 tablas"];
		const { dadas, error } = await leer(gzipDe(`${copia.join("\n")}\n`));
		expect(error).toBeUndefined();
		// Se comparan así, y no con un `toEqual` de las líneas, que pintaría 16 MiB al fallar.
		expect(dadas.map((l, i) => [l.length, l === copia[i]])).toEqual(copia.map((l) => [l.length, true]));
	}, 60_000);

	it("la de una copia de un negocio de antes de SALTOS_CON_CHAR, con cada salto escrito con char(10), pasa del tope si una fila lleva más de 1,27 millones: esa copia no se restaura", async () => {
		// Así escribe todos los saltos de un texto, lleve los que lleve, la copia de un negocio de un worker
		// anterior: 14 caracteres por salto. La línea de una fila de 8 MB puede pasar de 100 MiB, y ésa no
		// se puede juntar.
		const conSaltos = (texto: string) => `${PRINCIPIO_DE_INSERT}t" ("a") VALUES (${conChar(texto)});`;
		const sinSaltos = conSaltos("").length;
		expect(conSaltos(`${"\n".repeat(1000)}${"x".repeat(500)}`).length).toBe(sinSaltos + 14 * 1000 + 500);
		// Los que caben: solos, y en un texto de 8 MiB, el valor más grande que admite un objeto.
		expect(Math.floor((CARACTERES_POR_LINEA - sinSaltos) / 14)).toBe(1_273_268);
		expect(Math.floor((CARACTERES_POR_LINEA - sinSaltos - 8 * 1024 * 1024) / 13)).toBe(725_934);
		// Con uno más, la línea es demasiado larga en cuanto pasa del tope.
		const copia = ["-- Migraciones: m1", conSaltos("\n".repeat(1_273_269)), "-- Fin de la copia: 1 filas en 1 tablas"];
		expect(copia[1].length).toBeGreaterThan(CARACTERES_POR_LINEA);
		expect(await leer(gzipDe(`${copia.join("\n")}\n`))).toEqual({
			dadas: ["-- Migraciones: m1"],
			error: `copia_no_valida: la línea 2 es demasiado larga: pasa de ${CARACTERES_POR_LINEA} caracteres`,
		});
	}, 60_000);
});
