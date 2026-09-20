// test/dinero.test.ts
//
// El dinero de la webview contra la tabla que comparten las TRES implementaciones
// (`crates/tpv-domain/src/dinero_casos.json`). Si la Main o el worker cambian de criterio, esto
// se pone rojo hasta que se igualen.
//
// La trampa que la tabla existe para cerrar es real y ya mordio: `Math.round` de JavaScript lleva
// la mitad hacia +infinito y `f64::round` de Rust la aleja del cero, asi que -1,125 EUR daba -113
// centimos en el papel y -112 en la vista previa, y la tabla de golden del ticket no tenia ningun
// negativo en medio centimo que lo cazara.

import { describe, expect, it } from "vitest";

import casosJson from "../../../crates/tpv-domain/src/dinero_casos.json?raw";
import {
	aTexto,
	deCentimos,
	deEuros,
	deTexto,
	entre,
	escalar,
	eur,
	sumar,
	textoFiscal,
} from "../src/shared/lib/dinero";

const casos = JSON.parse(casosJson) as {
	de_euros: [number, number][];
	texto_fiscal: [number, string][];
	entre: [number, number, number][];
	escalar: [number, number, number][];
	sumar: [number[], number][];
};

describe("el dinero de la webview cuadra con la tabla compartida", () => {
	it("de_euros: la mitad se aleja del cero, como en Rust", () => {
		for (const [euros, centimos] of casos.de_euros) {
			expect(deEuros(euros), `deEuros(${euros})`).toBe(centimos);
		}
	});

	it("texto_fiscal: punto, dos decimales, sin menos cero", () => {
		for (const [centimos, texto] of casos.texto_fiscal) {
			expect(textoFiscal(deCentimos(centimos)), `textoFiscal(${centimos})`).toBe(texto);
		}
	});

	it("entre: dividir, no multiplicar por el reciproco", () => {
		for (const [centimos, divisor, esperado] of casos.entre) {
			expect(entre(deCentimos(centimos), divisor), `${centimos} entre ${divisor}`).toBe(
				esperado,
			);
		}
	});

	it("escalar: multiplicar por un factor fraccionario", () => {
		for (const [centimos, factor, esperado] of casos.escalar) {
			expect(escalar(deCentimos(centimos), factor), `${centimos} por ${factor}`).toBe(esperado);
		}
	});

	it("sumar: exacto y asociativo, que es el motivo de todo esto", () => {
		for (const [lista, esperado] of casos.sumar) {
			expect(sumar(...lista.map(deCentimos)), JSON.stringify(lista)).toBe(esperado);
		}
	});
});

describe("lo que se pinta en pantalla", () => {
	it("un importe se enseña en euros, no en centimos", () => {
		// El fallo que la marca NO caza por si sola: un Dinero sigue siendo un number, asi que
		// pasarselo a un formateador de euros compila y pinta «4750 EUR».
		expect(eur(deCentimos(4750))).toContain("47,50");
		expect(eur(deCentimos(0))).toContain("0,00");
		expect(eur(deCentimos(-1250))).toContain("12,50");
	});

	it("nunca sale «-0,00 EUR»", () => {
		expect(eur(deCentimos(-0))).not.toContain("-");
	});

	it("lo que no es un numero cuenta como cero, en TODAS las pantallas", () => {
		// Vivia en siete copias y solo cuatro protegian: el mismo importe corrupto salia «0,00 EUR»
		// en Estadisticas y «NaN EUR» en las tres pantallas de venta.
		expect(eur(Number.NaN as never)).toContain("0,00");
		expect(eur(Number.POSITIVE_INFINITY as never)).toContain("0,00");
	});

	it("en pantalla los miles SI llevan separador (el papel no)", () => {
		// `es-ES` no agrupa hasta las cinco cifras: 1234,56 EUR va sin punto y 12.345,67 con el.
		// Es justo el separador que el ticket NO puede llevar, porque en una columna de 32
		// caracteres se confunde con el decimal.
		expect(eur(deCentimos(1_234_567))).toContain("12.345,67");
	});
});

describe("lo que una persona teclea", () => {
	it("acepta la coma del teclado numerico y el punto", () => {
		expect(deTexto("3,50")).toBe(350);
		expect(deTexto("3.50")).toBe(350);
		expect(deTexto(" 12 ")).toBe(1200);
	});

	it("un campo vacio no es un cero", () => {
		// En un precio no son lo mismo: «gratis» y «sin rellenar» se deciden arriba.
		expect(deTexto("")).toBeNull();
		expect(deTexto("   ")).toBeNull();
		expect(deTexto("abc")).toBeNull();
	});

	it("ida y vuelta por el cuadro de texto que lo edita", () => {
		for (const c of [0, 5, 350, 123_456, -1250]) {
			expect(deTexto(aTexto(deCentimos(c))), `${c}`).toBe(c);
		}
	});
});
