// test/copiaDeFilasGrandes.node.test.ts
//
// La fila más grande que admite el SQLite de un objeto en producción (8 MB) se escribe en la copia
// con la mitad de la memoria del objeto (128 MB): de paso, `literalEnUnaLinea` (`volcadoSql.ts`) no
// ocupa más que la línea y lo justo para escribirla. Ni una cuerda con un nodo por byte (el
// hexadecimal escrito con `+=`, las comillas dobladas con `replaceAll`), unos 260 MB con un valor de
// 8 MB, ni una lista con cada salto de línea.
//
// Corre en un Node aparte con el montón acotado (`--max-old-space-size`), que es lo que hace fallar
// a quien se pasa, con el fuente de verdad convertido a JavaScript. Por eso es de Node: en workerd no
// se puede acotar la memoria de un test, y en local el SQLite de un objeto no admite filas de más de
// unos 2 MB.

import { spawn } from "node:child_process";
import ts from "typescript";
import { describe, expect, it } from "vitest";

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
