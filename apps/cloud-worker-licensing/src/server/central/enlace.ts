// src/server/central/enlace.ts
//
// Cómo se convierte un argumento de una sentencia de la base central en lo que guarda su SQLite.
//
// La central siempre ha guardado lo que dejaba pasar libsql, que rechazaba lo que no sabía guardar
// (un `undefined`, un número que no lo es) y convertía lo demás de una forma fija. El SQLite de un
// Durable Object, en cambio, guarda un booleano como el texto 'true' y una fecha como su texto en
// inglés, sin avisar (`test/centralEnlace.test.ts`). Así que todo lo que va a la central pasa por
// aquí: en el Worker, antes de salir (`cliente.ts`), y en el objeto, antes de ejecutar
// (`durableObjects/baseCentral.ts`). Lo que acepta y lo que rechaza es lo de libsql
// (`@libsql/hrana-client`, `valueToProto`):
//
//   null, texto, ArrayBuffer      tal cual
//   número                        tal cual; NaN o ±Infinity lanzan
//   booleano                      1 o 0
//   bigint                        el mismo número; si no cabe sin perder precisión, lanza
//   Date                          sus milisegundos; una fecha no válida lanza
//   Uint8Array                    sus bytes
//   undefined, símbolo, función   lanzan
//   cualquier otro objeto         su `toString()`
//
// Dos diferencias en lo que rechaza, las dos para no guardar algo distinto de lo que se pasó: un
// `bigint` entre 2^53 y 2^63, que libsql guardaba exacto y el SQLite de un DO no puede recibir
// (sólo admite `number`), y una `Date` no válida, que libsql mandaba como NaN.
//
// Y una en lo que guarda: el SQLite de un DO enlaza todo número como REAL, y no hay forma de
// enlazar un entero. libsql también mandaba así los números, pero un booleano o un `bigint` los
// mandaba como enteros. En una columna INTEGER o REAL se guarda lo mismo; en un texto (una columna
// TEXT, `CAST(? AS TEXT)`, `json_object`), `true` sale «1.0» donde con libsql salía «1».

import type { Sentencia, Valor } from "../../lib/sql";
import type { SentenciaEnlazada } from "../../durableObjects/baseCentral.rpc";

const MAYOR_SEGURO = BigInt(Number.MAX_SAFE_INTEGER);
const MENOR_SEGURO = BigInt(Number.MIN_SAFE_INTEGER);

/** Un argumento como lo guarda la central. Lanza con lo que no guarda. */
export function valorEstricto(v: unknown): Valor {
	if (v === null || typeof v === "string") return v;
	if (typeof v === "number") {
		if (!Number.isFinite(v)) throw new RangeError(`La base central sólo guarda números finitos, no ${v}.`);
		return v;
	}
	if (typeof v === "boolean") return v ? 1 : 0;
	if (typeof v === "bigint") {
		if (v > MAYOR_SEGURO || v < MENOR_SEGURO) {
			throw new RangeError("La base central no guarda un bigint que no cabe en un número sin perder precisión.");
		}
		return Number(v);
	}
	if (v instanceof ArrayBuffer) return v;
	if (v instanceof Uint8Array) return v.slice().buffer;
	if (v instanceof Date) {
		const ms = v.valueOf();
		if (!Number.isFinite(ms)) throw new RangeError("La base central no guarda una fecha no válida.");
		return ms;
	}
	if (typeof v === "object") return String(v.toString());
	throw new TypeError(`La base central no guarda un valor de tipo ${typeof v}.`);
}

/** Los argumentos de una sentencia como los guarda la central. Sólo posicionales. */
export function argumentosEstrictos(args: unknown): Valor[] {
	if (args === undefined) return [];
	if (!Array.isArray(args)) throw new TypeError("La base central sólo admite argumentos posicionales.");
	// `Array.from` recorre también los huecos de un array disperso, que son `undefined`.
	return Array.from(args, (v, i) => {
		try {
			return valorEstricto(v);
		} catch (e) {
			(e as Error).message = `?${i + 1}: ${(e as Error).message}`;
			throw e;
		}
	});
}

/** Una sentencia de la central con sus argumentos convertidos. */
export function enlazar(sentencia: Sentencia | SentenciaEnlazada): SentenciaEnlazada {
	if (typeof sentencia === "string") return { sql: sentencia, args: [] };
	if (typeof sentencia?.sql !== "string") throw new TypeError("Una sentencia de la base central es un texto.");
	return { sql: sentencia.sql, args: argumentosEstrictos(sentencia.args) };
}
