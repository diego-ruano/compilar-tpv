// test/dinero.test.ts
//
// El dinero del worker contra la tabla que comparten las TRES implementaciones
// (`crates/tpv-domain/src/dinero_casos.json`). Si la Main cambia de criterio, esto se pone rojo
// hasta que se igualen: es lo unico que impide que deriven, porque no pueden compartir codigo.
//
// La trampa que esta tabla existe para cerrar: `Math.round` de JavaScript lleva la mitad hacia
// +infinito y `f64::round` de Rust la aleja del cero, asi que -1,125 EUR daba -113 centimos en el
// papel y -112 en la vista previa.

import { describe, expect, it } from "vitest";

import casosJson from "../../../crates/tpv-domain/src/dinero_casos.json?raw";
import {
	deCentimos,
	entre,
	escalar,
	redondear,
	sumar,
	textoFiscal,
	zDinero,
} from "../src/lib/dinero";

const casos = JSON.parse(casosJson) as {
	de_euros: [number, number][];
	texto_fiscal: [number, string][];
	entre: [number, number, number][];
	escalar: [number, number, number][];
	sumar: [number[], number][];
};

/** Euros -> centimos por el mismo camino que `Dinero::de_euros` en Rust. */
function deEuros(euros: number) {
	return redondear(euros * 100);
}

describe("el dinero del worker cuadra con la tabla compartida", () => {
	it("de_euros: la mitad se aleja del cero, como en Rust", () => {
		for (const [euros, centimos] of casos.de_euros) {
			expect(deEuros(euros), `de_euros(${euros})`).toBe(centimos);
		}
	});

	it("texto_fiscal: punto, dos decimales, sin menos cero", () => {
		for (const [centimos, texto] of casos.texto_fiscal) {
			expect(textoFiscal(deCentimos(centimos)), `texto_fiscal(${centimos})`).toBe(texto);
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

describe("lo que la tabla no cubre pero el worker necesita", () => {
	it("un importe de la API tiene que venir en centimos enteros", () => {
		expect(zDinero.safeParse(1250).success).toBe(true);
		// 12.5 ya no es «doce euros con medio»: es un cliente hablando en la unidad equivocada.
		expect(zDinero.safeParse(12.5).success).toBe(false);
	});

	it("lo que sale de la base puede llegar como bigint", () => {
		expect(deCentimos(Number(1250n))).toBe(1250);
	});
});
