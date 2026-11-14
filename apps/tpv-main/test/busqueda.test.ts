// test/busqueda.test.ts
//
// Las listas que filtra la propia pantalla buscan como la base: sin acentos ni mayúsculas, con la
// tabla que comparten la Main y el worker (`crates/tpv-domain/src/busqueda_casos.json`). Si cambia
// la tabla y no esto, se pone rojo.

import { describe, expect, it } from "vitest";

import casosJson from "../../../crates/tpv-domain/src/busqueda_casos.json?raw";
import { contiene, normalizarBusqueda, PLIEGUES, SE_QUITAN, textoABuscar } from "../src/shared/lib/busqueda";

const casos = JSON.parse(casosJson) as {
	pliegues: Record<string, string>;
	se_quitan: string[];
	normalizar: { texto: string; queda: string }[];
	a_buscar: { texto: string; queda: string | null }[];
	buscar: { nombre: string; busca: string; encuentra: boolean }[];
};

describe("la búsqueda de las pantallas cuadra con la tabla compartida", () => {
	it("las letras que se pliegan y las marcas que se quitan son las de los casos", () => {
		expect(Object.fromEntries(PLIEGUES)).toEqual(casos.pliegues);
		expect([...SE_QUITAN]).toEqual(casos.se_quitan);
	});

	it.each(casos.normalizar)("normaliza $texto", ({ texto, queda }) => {
		expect(normalizarBusqueda(texto)).toBe(queda);
		expect(normalizarBusqueda(normalizarBusqueda(texto))).toBe(queda);
	});

	it.each(casos.buscar)("$nombre con $busca", ({ nombre, busca, encuentra }) => {
		const buscado = textoABuscar(busca);
		expect(buscado).not.toBeNull();
		expect(contiene(buscado!, nombre)).toBe(encuentra);
	});

	it.each(casos.a_buscar)("lo tecleado $texto se busca como $queda", ({ texto, queda }) => {
		expect(textoABuscar(texto)).toBe(queda);
	});

	it("sin texto no filtra", () => {
		expect(textoABuscar(null)).toBeNull();
		expect(textoABuscar(undefined)).toBeNull();
	});

	it("busca en cualquiera de los textos y se salta los que faltan", () => {
		expect(contiene("nandu", null, undefined, "Cafés Ñandú")).toBe(true);
		expect(contiene("nandu", null, "Otro")).toBe(false);
	});
});
