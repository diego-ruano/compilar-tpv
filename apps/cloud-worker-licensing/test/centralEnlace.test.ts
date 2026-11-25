// test/centralEnlace.test.ts
//
// Cómo se guardan los argumentos de una sentencia de la base central (`server/central/enlace.ts`).
//
// La tabla de abajo es la regla, caso a caso: lanza lo que se guardaría distinto de lo que se pasó
// (un número que no es finito, un `bigint` que no cabe en un número sin perder precisión, una fecha
// no válida) y lo que no es un valor (`undefined`, un símbolo, una función); lo demás se convierte
// siempre igual. De unos bytes se guardan los de su vista, también de un `Buffer` de Node. Y lo que
// el SQLite de un Durable Object no deja evitar: un booleano o un `bigint` se enlazan como REAL, no
// como enteros.
//
// Y por qué hace falta: el SQLite de un DO, por su cuenta, guarda otra cosa sin avisar.

import { Buffer } from "node:buffer";

import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { BaseCentral } from "../src/durableObjects/baseCentral";
import { argumentosEstrictos, valorEstricto } from "../src/server/central/enlace";
import { clienteCentral } from "../src/server/central/cliente";
import { centralDePrueba, centralSinAprovisionar } from "./helpers/central";

const BYTES = new Uint8Array([1, 2, 3, 4]);

/**
 * Un `Buffer` de tres bytes (5, 6, 7) en medio de un almacén de 16, con otros bytes a los lados:
 * como los que reparte Node de su almacén común.
 */
function bufferEnMedio(): Buffer {
	const almacen = new Uint8Array(16).fill(0xee);
	almacen.set([5, 6, 7], 4);
	return Buffer.from(almacen.buffer, 4, 3);
}

/** Lo que guarda la central de cada argumento; `"lanza"` si no lo guarda. */
const CASOS: [string, unknown, unknown][] = [
	["null", null, null],
	["texto", "hola", "hola"],
	["entero", 42, 42],
	["decimal", 1.5, 1.5],
	["NaN", NaN, "lanza"],
	["Infinity", Infinity, "lanza"],
	["-Infinity", -Infinity, "lanza"],
	["true", true, 1],
	["false", false, 0],
	["bigint", 10n, 10],
	["bigint en el borde", BigInt(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
	["bigint negativo en el borde", BigInt(Number.MIN_SAFE_INTEGER), Number.MIN_SAFE_INTEGER],
	// Pasado ±(2^53 − 1), como número ya es otro: se guardaría redondeado.
	["bigint que no cabe en un número", BigInt(Number.MAX_SAFE_INTEGER) + 1n, "lanza"],
	["bigint de más de 64 bits", 2n ** 63n, "lanza"],
	["Date", new Date(1_700_000_000_000), 1_700_000_000_000],
	// No tiene milisegundos que guardar (son NaN).
	["Date no válida", new Date("no es una fecha"), "lanza"],
	["undefined", undefined, "lanza"],
	["símbolo", Symbol("s"), "lanza"],
	["función", () => 1, "lanza"],
	["objeto", {}, "[object Object]"],
	["array", [1, 2], "1,2"],
	["objeto con su toString", { toString: () => "propio" }, "propio"],
	["otra vista que no es Uint8Array", new Int16Array([1, 2]), "1,2"],
];

describe("el enlace estricto", () => {
	it.each(CASOS)("%s", (_nombre, entrada, esperado) => {
		if (esperado === "lanza") {
			expect(() => valorEstricto(entrada)).toThrow();
		} else {
			expect(valorEstricto(entrada)).toBe(esperado);
		}
	});

	it("los bytes: un ArrayBuffer tal cual, un Uint8Array con sólo los de su vista", () => {
		const buffer = BYTES.buffer.slice(0);
		expect(valorEstricto(buffer)).toBe(buffer);
		const deUnaVista = valorEstricto(new Uint8Array(BYTES.buffer, 1, 2));
		expect(deUnaVista).toBeInstanceOf(ArrayBuffer);
		expect([...new Uint8Array(deUnaVista as ArrayBuffer)]).toEqual([2, 3]);
	});

	it("un Buffer de Node, también con sólo los de su vista: su `slice` no copia", () => {
		const vista = bufferEnMedio();
		const enlazado = valorEstricto(vista);
		expect(enlazado).toBeInstanceOf(ArrayBuffer);
		expect([...new Uint8Array(enlazado as ArrayBuffer)]).toEqual([5, 6, 7]);
		// Una copia: lo que se guarde no cambia si alguien escribe después en la vista.
		vista[0] = 99;
		expect([...new Uint8Array(enlazado as ArrayBuffer)]).toEqual([5, 6, 7]);
	});

	it("sólo argumentos posicionales, y el error dice cuál", () => {
		expect(argumentosEstrictos(undefined)).toEqual([]);
		expect(argumentosEstrictos([true, "x"])).toEqual([1, "x"]);
		expect(() => argumentosEstrictos({ id: 1 })).toThrow(/posicionales/);
		expect(() => argumentosEstrictos(["a", undefined])).toThrow(/^\?2: /);
		// Un hueco de un array disperso es un `undefined`, no un NULL.
		const conHueco: unknown[] = [1];
		conHueco[2] = 3;
		expect(() => argumentosEstrictos(conHueco)).toThrow(/^\?2: /);
	});
});

describe("por qué hace falta", () => {
	it("el SQLite de un Durable Object, por su cuenta, guarda un booleano y una fecha como texto", async () => {
		const { stub } = centralSinAprovisionar();
		const guardado = await runInDurableObject(stub, (_central, state) => {
			const tipo = (v: unknown) =>
				state.storage.sql.exec("SELECT typeof(?1) AS t, ?1 AS v;", v).one() as { t: string; v: unknown };
			return { booleano: tipo(true), fecha: tipo(new Date(0)) };
		});
		expect(guardado.booleano).toEqual({ t: "text", v: "true" });
		expect(guardado.fecha.t).toBe("text");
	});
});

describe("el cliente y el objeto enlazan así", () => {
	it("lo que llega a la base es lo de la tabla", async () => {
		const { db } = await centralDePrueba();
		await db.execute({
			sql: "INSERT INTO tenants (tenant_id, piloto, created_at_ms, updated_at_ms, notes, field_dek) VALUES ('t', ?1, ?2, ?3, ?4, ?5);",
			args: [true as any, new Date(1_700_000_000_000) as any, 7n as any, new Uint8Array([5, 6]) as any, null],
		});
		const fila = (
			await db.execute(
				`SELECT typeof(piloto) AS tp, piloto, typeof(created_at_ms) AS tc, created_at_ms,
				        typeof(updated_at_ms) AS tu, updated_at_ms, typeof(notes) AS tn, typeof(field_dek) AS tf
				 FROM tenants;`,
			)
		).rows[0];
		expect(fila).toMatchObject({
			tp: "integer",
			piloto: 1,
			tc: "integer",
			created_at_ms: 1_700_000_000_000,
			tu: "integer",
			updated_at_ms: 7,
			tn: "blob",
			tf: "null",
		});
	});

	it("de un Buffer de Node llegan sólo los bytes de su vista, no el almacén entero", async () => {
		const { db } = await centralDePrueba();
		const fila = (await db.execute({ sql: "SELECT length(?1) AS n, hex(?1) AS h;", args: [bufferEnMedio() as any] })).rows[0];
		expect(fila).toMatchObject({ n: 3, h: "050607" });
	});

	it("un número viaja como REAL: una columna INTEGER lo guarda entero", async () => {
		const { db } = await centralDePrueba();
		expect((await db.execute({ sql: "SELECT typeof(?1) AS t;", args: [1] })).rows[0].t).toBe("real");
		await db.execute({ sql: "INSERT INTO tenants (tenant_id, piloto) VALUES ('t', ?1);", args: [1] });
		expect((await db.execute("SELECT typeof(piloto) AS t FROM tenants;")).rows[0].t).toBe("integer");
	});

	it("un booleano o un bigint, también: en un texto se nota, «1.0» y no «1»", async () => {
		const { db } = await centralDePrueba();
		const comoTexto = { sql: "SELECT typeof(?1) AS t, CAST(?1 AS TEXT) AS s, json_object('a', ?1) AS j;" };
		expect((await db.execute({ ...comoTexto, args: [true as any] })).rows[0]).toMatchObject({
			t: "real",
			s: "1.0",
			j: '{"a":1.0}',
		});
		expect((await db.execute({ ...comoTexto, args: [5n as any] })).rows[0]).toMatchObject({ t: "real", s: "5.0" });
	});

	it("lo que no se guarda lanza en el Worker, sin llegar a viajar", async () => {
		let viajes = 0;
		const stub = {
			ejecutar: async () => {
				viajes++;
				return { ok: true, valor: { columns: [], rows: [], rowsAffected: 0, lastInsertRowid: null } };
			},
		};
		const db = clienteCentral(() => stub as any);
		await expect(db.execute({ sql: "SELECT ?1;", args: [undefined as any] })).rejects.toThrow(/\?1: /);
		await expect(db.batch([{ sql: "SELECT ?1;", args: [NaN] }])).rejects.toThrow(/finitos/);
		expect(viajes).toBe(0);
	});

	it("el objeto también enlaza lo que le llega por su RPC", async () => {
		const { stub } = await centralDePrueba();
		const r = await stub.ejecutar({ sql: "SELECT ?1 AS v;", args: [true as any] });
		expect(r.ok && r.valor.rows).toEqual([[1]]);
		// Lo que no se guarda se prueba en la instancia, no por RPC: cuando un método RPC lanza, workerd
		// escribe del lado del objeto un «uncaught exception» aunque quien llama recoja el rechazo (un
		// `return await` del que llama no lo quita), y saldría en cada pasada de la suite. Dentro del
		// objeto, el rechazo se recoge en el mismo isolate. Lo que se mira es lo mismo: que `ejecutar`
		// enlaza los argumentos él también, sin fiarse de que lo haya hecho el cliente.
		await runInDurableObject(stub, async (instancia) => {
			const objeto = instancia as unknown as BaseCentral;
			await expect(objeto.ejecutar({ sql: "SELECT ?1;", args: [undefined as any] })).rejects.toThrow(/\?1: /);
		});
	});
});
