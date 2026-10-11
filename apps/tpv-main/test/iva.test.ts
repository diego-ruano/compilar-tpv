// test/iva.test.ts
//
// El rango del IVA en la webview contra la tabla que comparten las TRES implementaciones
// (`crates/tpv-domain/src/validacion_casos.json`, RI-78): `validate_iva_percent` en la Main, `zIva`
// en el worker y `ivaEnRango` aquí. Habían sido tres criterios —0–100, 0–30 y un recorte silencioso
// a 0–30—; si alguno vuelve a cambiar, esto se pone rojo hasta que se igualen.

import { describe, expect, it } from "vitest";

import casosJson from "../../../crates/tpv-domain/src/validacion_casos.json?raw";
import { ivaEnRango, leerIva } from "../src/shared/lib/iva";

type Caso = { nombre: string; cambios: { iva_percent?: unknown }; acepta: boolean };
const tabla = JSON.parse(casosJson) as Record<string, { casos: Caso[] }>;

/** Los casos de un dominio que cambian el IVA por un número. */
function casosDeIva(dominio: string): [string, number, boolean][] {
	return (tabla[dominio]?.casos ?? [])
		.filter((c) => typeof c.cambios.iva_percent === "number")
		.map((c) => [c.nombre, c.cambios.iva_percent as number, c.acepta]);
}

describe("el IVA de la webview cuadra con la tabla compartida", () => {
	it("la tabla trae casos de IVA", () => {
		expect(casosDeIva("negocio").length).toBeGreaterThan(0);
	});

	it.each(casosDeIva("negocio"))("negocio · %s", (_nombre, iva, acepta) => {
		expect(ivaEnRango(iva)).toBe(acepta);
		// Y lo mismo tecleado en el campo, con punto y con coma.
		expect(leerIva(String(iva)) !== null).toBe(acepta);
		expect(leerIva(String(iva).replace(".", ",")) !== null).toBe(acepta);
	});
});

describe("leer un IVA tecleado", () => {
	it("entiende la coma y el punto, y recorta los espacios", () => {
		expect(leerIva("21")).toBe(21);
		expect(leerIva(" 10,5 ")).toBe(10.5);
		expect(leerIva("10.5")).toBe(10.5);
		expect(leerIva("0")).toBe(0);
	});

	it("no adivina: lo que no es un número escrito entero no vale", () => {
		for (const texto of ["", "  ", "abc", "21%", "10.", ",5", "1e2", "0x10", "Infinity", "NaN", "-0"]) {
			expect(leerIva(texto), JSON.stringify(texto)).toBeNull();
		}
	});

	it("no recorta: fuera de rango no devuelve el límite", () => {
		expect(leerIva("210")).toBeNull();
		expect(leerIva("100,01")).toBeNull();
		expect(leerIva("-21")).toBeNull();
	});
});
