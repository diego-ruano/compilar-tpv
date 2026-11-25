// src/server/central/enlace.ts
//
// Cómo se convierte un argumento de una sentencia de la base central en lo que guarda su SQLite.
//
// El SQLite de un Durable Object guarda lo que se le pase sin avisar de nada: un booleano, como el
// texto 'true'; una fecha, como su texto en inglés (`test/centralEnlace.test.ts`). Así que todo lo
// que va a la central pasa por aquí: en el Worker, antes de salir (`cliente.ts`), y en el objeto,
// antes de ejecutar (`durableObjects/baseCentral.ts`). Lo que no se puede guardar tal como se pasó
// lanza, y lo demás se convierte siempre igual:
//
//   null, texto, ArrayBuffer      tal cual
//   número                        tal cual; NaN o ±Infinity lanzan
//   booleano                      1 o 0
//   bigint                        el mismo número; si no cabe en uno sin perder precisión, lanza
//   Date                          sus milisegundos; una fecha no válida lanza
//   Uint8Array (y Buffer)         una copia de los bytes de su vista, y sólo ésos
//   undefined, símbolo, función   lanzan
//   cualquier otro objeto         su `toString()`
//
// Lo que lanza es lo que se guardaría distinto de lo que se pasó, o lo que no es un valor: un número
// que no es finito; un `bigint` más allá de ±(2^53 − 1), que el SQLite de un DO sólo puede recibir
// como `number`, ya redondeado; una fecha no válida, que no tiene milisegundos; y un `undefined`, un
// símbolo o una función, que son un fallo de quien llama y no un NULL.
//
// Y un número se enlaza siempre como REAL: el SQLite de un DO no deja enlazar un entero. En una
// columna INTEGER o REAL se guarda lo mismo; en un texto (una columna TEXT, `CAST(? AS TEXT)`,
// `json_object`), un booleano o un `bigint` salen «1.0», no «1».

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
	// `new Uint8Array(v)` copia los bytes de la vista a un almacén propio. `v.slice()` no vale: el de un
	// `Buffer` de Node no copia, y su `.buffer` es el almacén entero, con lo que haya a los lados.
	if (v instanceof Uint8Array) return new Uint8Array(v).buffer;
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
