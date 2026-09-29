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
	esVacio,
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

describe("lo que una persona teclea (deTexto, el unico lector)", () => {
	// Habia dos lectores (RI-53). El de los formularios era `Number(texto.replace(",", "."))`: leia
	// «1.500» como 1,50 €, no entendia «150 €» y redondeaba «2,555» sin avisar. El del fondo del
	// cierre (`leerImporte`) ya lo hacia bien; sus casos son los de aqui.

	it.each([
		["0", 0],
		["150", 15_000],
		["0150", 15_000],
		[" 150 ", 15_000],
		["1250", 125_000],
		["150,50", 15_050],
		["150,5", 15_050],
		["0,05", 5],
		["3,50", 350],
		["150.50", 15_050],
		["150.5", 15_050],
		// Un punto con tres cifras detras agrupa miles, como se escribe en España.
		["1.500", 150_000],
		["1.250", 125_000],
		["12.000", 1_200_000],
		["150.555", 15_055_500],
		["1.234,56", 123_456],
		["150 €", 15_000],
		["1 500", 150_000],
		["1.234.567,89", 123_456_789],
		["1,234.56", 123_456],
		["1 500,50", 150_050],
		["150€", 15_000],
		["€150", 15_000],
		["€ 150", 15_000],
		["1.500,00 €", 150_000],
	])("«%s» → %s céntimos", (texto, esperado) => {
		expect(deTexto(texto)).toBe(esperado);
	});

	it.each([
		// Dos lecturas posibles: no se adivina.
		["1,500"],
		["0.500"],
		// Mas de dos decimales: no se redondea a escondidas.
		["150,555"],
		["2,555"],
		["1.5000"],
		// Separadores que no agrupan de tres en tres, o repetidos donde va el decimal.
		["1..5"],
		["1.2,5"],
		["12.34,5"],
		["1,2,3"],
		["1,234,56"],
		["150 50"],
		// Media cifra.
		["150,"],
		["150."],
		[",50"],
		[".50"],
		// Ningun campo de dinero de la interfaz es negativo.
		["-50"],
		["+50"],
		["abc"],
		["150€50"],
		["1e3"],
		["99999999999999999"],
	])("«%s» no se entiende", (texto) => {
		expect(deTexto(texto)).toBeNull();
		expect(esVacio(texto)).toBe(false);
	});

	it("un campo vacio no es un cero, y se distingue de uno que no se entiende", () => {
		// En un precio no son lo mismo: «gratis» y «sin rellenar» se deciden arriba.
		for (const t of ["", "   ", " € "]) {
			expect(deTexto(t), `«${t}»`).toBeNull();
			expect(esVacio(t), `«${t}»`).toBe(true);
		}
	});

	it("ida y vuelta por el cuadro de texto que lo edita", () => {
		for (const c of [0, 5, 350, 123_456, 100_000_000]) {
			expect(deTexto(aTexto(deCentimos(c))), `${c}`).toBe(c);
		}
	});

	it("barrido: cualquier importe escrito como lo pinta la pantalla, o a mano, se lee exacto", () => {
		for (let cent = 0; cent <= 2_000_000; cent += 137) {
			const [euros, decimales] = [Math.floor(cent / 100), String(cent % 100).padStart(2, "0")];
			for (const escrito of [
				eur(deCentimos(cent)),
				aTexto(deCentimos(cent)),
				`${euros},${decimales}`,
				`${euros}.${decimales}`,
				`${euros}`,
			]) {
				const esperado = escrito === `${euros}` ? euros * 100 : cent;
				const leido = deTexto(escrito);
				if (leido !== esperado) throw new Error(`«${escrito}» se lee ${leido}, no ${esperado}`);
			}
		}
	});
});
