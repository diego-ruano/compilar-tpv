// test/copiaDeFilasGrandes.node.test.ts
//
// Una fila de megas, en la copia, no ocupa de paso más memoria que la suya:
//
//   · Al escribirla: la más grande que admite el SQLite de un objeto en producción (8 MB) se escribe
//     con la mitad de la memoria del objeto (128 MB). `literalEnUnaLinea` (`volcadoSql.ts`) no deja
//     una cuerda con un nodo por byte (el hexadecimal escrito con `+=`, las comillas dobladas con
//     `replaceAll`), unos 260 MB con un valor de 8 MB, ni una lista con cada salto de línea. Corre en
//     un Node aparte con el montón acotado (`--max-old-space-size`), que es lo que hace fallar a quien
//     se pasa, con el fuente de verdad convertido a JavaScript.
//   · Al leerla (`cargaDeCopias.ts`): el texto que sale de la línea es uno, plano, y no una cuerda con
//     un nodo por comilla doblada o por salto escrito con `char(10)`. Se mira lo que hay vivo en el
//     montón cuando su fila llega a SQLite, con el cargador de verdad sobre una base de node:sqlite.
//
// Por eso es de Node: en workerd no se puede acotar ni medir la memoria de un test, y en local el
// SQLite de un objeto no admite filas de más de unos 2 MB.

import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import v8 from "node:v8";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { cargarCopia } from "../src/durableObjects/cargaDeCopias";
import fuente from "../src/durableObjects/volcadoSql.ts?raw";

/** `volcadoSql.ts` en JavaScript, tal cual. */
const modulo = ts.transpileModule(fuente, {
	compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;

/** La mitad de la memoria de un objeto, en MiB. */
const MONTON_MIB = 64;

/** El valor más grande que admite el SQLite de un objeto en producción (`MAX_ROW_LENGTH` de workerd). */
const OCHO_MIB = 8 * 1024 * 1024;

/**
 * Corre `programa` detrás de `volcadoSql.ts` en un Node con `MONTON_MIB` de montón: lo que escribe, o
 * cómo ha terminado si no ha podido.
 */
function conElMontonAcotado(programa: string): Promise<{ codigo: number | null; salida: string; errores: string }> {
	return new Promise((resolver, fallar) => {
		const hijo = spawn(process.execPath, [`--max-old-space-size=${MONTON_MIB}`, "--input-type=module", "-"], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		let salida = "";
		let errores = "";
		hijo.stdout.on("data", (d) => (salida += d));
		hijo.stderr.on("data", (d) => (errores += d));
		hijo.on("error", fallar);
		hijo.on("close", (codigo) => resolver({ codigo, salida, errores: errores.slice(0, 600) }));
		hijo.stdin.end(`${modulo}\n${programa}\n`);
	});
}

describe("la línea de la fila más grande que admite un objeto, con la mitad de su memoria", () => {
	/** Qué valor, cómo se construye (en el Node aparte) y cuánto ocupa su línea. */
	const casos: [string, string, number][] = [
		// En hexadecimal: con más de 40 saltos, con un NUL, y los bytes.
		["saltos de línea", `"\\n".repeat(${OCHO_MIB})`, 7 + 2 * OCHO_MIB + 10],
		["saltos de Windows", `"\\r\\n".repeat(${OCHO_MIB / 2})`, 7 + 2 * OCHO_MIB + 10],
		["un NUL delante", `"\\0" + "x".repeat(${OCHO_MIB - 1})`, 7 + 2 * OCHO_MIB + 10],
		["unos bytes", `new Uint8Array(${OCHO_MIB}).fill(0xab).buffer`, 2 + 2 * OCHO_MIB + 1],
		// Entre comillas, con cada comilla doblada.
		["comillas", `"'".repeat(${OCHO_MIB})`, 1 + 2 * OCHO_MIB + 1],
		["comillas entre letras de tres bytes", `"€'".repeat(${OCHO_MIB / 4})`, 1 + 3 * (OCHO_MIB / 4) + 1],
		// Con todos los saltos que se escriben con `char(10)`, y comillas.
		["40 saltos y comillas", `"\\n".repeat(40) + "'".repeat(${OCHO_MIB - 40})`, 4 + 40 * 14 + 2 * (OCHO_MIB - 40)],
	];

	it.each(casos)("%s", async (_que, valor, largo) => {
		const r = await conElMontonAcotado(`process.stdout.write(String(literalEnUnaLinea(${valor}).length));`);
		expect(r).toEqual({ codigo: 0, salida: String(largo), errores: "" });
	}, 60_000);

	it("y la cuenta del montón se hace de verdad: con una cuerda así, no le llega", async () => {
		// Lo que escribe la línea si se junta cifra a cifra: el Node aparte se queda sin memoria.
		const r = await conElMontonAcotado(
			`let s = ""; const b = new Uint8Array(${OCHO_MIB}); for (const x of b) s += x.toString(16).padStart(2, "0"); process.stdout.write(String(s.length));`,
		);
		expect(r.codigo).not.toBe(0);
		expect(r.errores).toMatch(/heap out of memory/i);
	}, 60_000);
});

describe("el texto de una línea de megas sale plano de la copia, sin una cuerda", () => {
	v8.setFlagsFromString("--expose-gc");
	const gc = vm.runInNewContext("gc") as () => void;
	/** Lo que hay vivo en el montón, en bytes, tras dos gc. */
	const vivo = () => {
		gc();
		gc();
		return process.memoryUsage().heapUsed;
	};

	/**
	 * El almacenamiento de un objeto sobre una base de node:sqlite, con lo que usa el cargador y nada
	 * más. Un `INSERT` con argumentos es el de una fila que no cabe en una llamada, con sus textos ya
	 * leídos: antes de ejecutarlo se llama a `alEjecutar`.
	 */
	function almacen(db: DatabaseSync, alEjecutar: () => void): DurableObjectStorage {
		const sql = {
			exec(consulta: string, ...args: (string | number | null)[]) {
				let filas: Record<string, unknown>[] = [];
				if (!/^\s*(INSERT|DELETE)\b/i.test(consulta)) {
					filas = db.prepare(consulta).all(...args) as Record<string, unknown>[];
				} else if (args.length) {
					alEjecutar();
					db.prepare(consulta).run(...args);
				} else {
					// Las filas cortas van varias en un texto.
					db.exec(consulta);
				}
				return { toArray: () => filas };
			},
		};
		return {
			sql,
			sync: async () => {},
			transactionSync<T>(cuerpo: () => T): T {
				db.exec("SAVEPOINT carga;");
				try {
					const r = cuerpo();
					db.exec("RELEASE carga;");
					return r;
				} catch (error) {
					db.exec("ROLLBACK TO carga; RELEASE carga;");
					throw error;
				}
			},
		} as unknown as DurableObjectStorage;
	}

	/**
	 * Carga una copia con una sola fila, `INSERT INTO "t" ("id", "a") VALUES (1, <literal>);`, y dice
	 * cuánto había vivo de más cuando su fila llegó a SQLite, y qué texto ha quedado en la tabla.
	 */
	async function cargarUna(literal: string): Promise<{ deMas: number; a: string }> {
		const db = new DatabaseSync(":memory:");
		// La línea, ya plana, como la da `lineasDe`: una cuerda la aplanaría la lectura, y se contaría.
		const fila = ['INSERT INTO "t" ("id", "a") VALUES (1, ', literal, ");"].join("");
		const lineas = ["-- Copia de prueba", "-- Migraciones: m1", fila, "-- Fin de la copia: 1 filas en 1 tablas"];
		let deMas = Number.NaN;
		const base = vivo();
		await cargarCopia(
			almacen(db, () => (deMas = vivo() - base)),
			(async function* () {
				yield* lineas;
			})(),
			{ migraciones: ["m1"], esTablaDeLaCopia: (t) => t === "t", prepararBase: async () => db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT);") },
		);
		return { deMas, a: (db.prepare("SELECT a FROM t;").get() as { a: string }).a };
	}

	const MiB = 1024 * 1024;

	it("con millones de comillas dobladas", async () => {
		const n = 2 * MiB;
		const { deMas, a } = await cargarUna(`'${"''".repeat(n)}'`);
		expect(a === "'".repeat(n), "el texto ha vuelto entero").toBe(true);
		// El texto, plano, ocupa 2 MiB; con un nodo por comilla, más de 40.
		expect(deMas).toBeLessThan(8 * MiB);
	});

	it("con cientos de miles de saltos escritos con char(10), como la copia de un negocio de antes", async () => {
		const n = 500_000;
		const { deMas, a } = await cargarUna(`('a'${"||char(10)||'a'".repeat(n)})`);
		expect(a === `a${"\na".repeat(n)}`, "el texto ha vuelto entero").toBe(true);
		// El texto, plano, ocupa 1 MiB; con dos nodos por salto, más de 15.
		expect(deMas).toBeLessThan(6 * MiB);
	});
});
