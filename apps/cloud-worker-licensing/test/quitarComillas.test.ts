// test/quitarComillas.test.ts
//
// AUD-33 · `quitarComillas` (lib/texto.ts) sustituye a `/^"+|"+$/g`, que corría sobre la firma y la
// clave del dispositivo antes de saber quién llamaba. Este motor de expresiones regulares retrocede:
// en un texto con una racha interior de comillas, `"+$` se prueba desde cada una y la recorre entera
// desde cada una, y el tiempo crece con el cuadrado de la racha (125 KB de cabecera, unos 20 s de CPU).
//
// Aquí, sin medir tiempos:
//   1. Que da exactamente lo mismo que la expresión: una tabla de casos y todas las cadenas cortas de
//      un alfabeto con comillas.
//   2. Que es lineal: no ejecuta ninguna expresión regular y lee cada carácter como mucho una vez
//      (cuenta sus `charCodeAt`), también con 200.000 comillas, donde la expresión daba del orden de
//      20.000 millones de pasos.

import { describe, expect, it } from "vitest";

import { quitarComillas } from "../src/lib/texto";

/** La expresión de antes: es la referencia de lo que tiene que salir. */
const conLaExpresion = (texto: string) => texto.replace(/^"+|"+$/g, "");

const C = '"';

/**
 * Ejecuta `f` contando las expresiones regulares que corre (toda operación con una acaba en su
 * `exec`) y los caracteres que lee con `charCodeAt`. Se restauran antes de devolver.
 */
function contando<T>(f: () => T): { valor: T; expresiones: number; lecturas: number } {
	const exec = RegExp.prototype.exec;
	const charCodeAt = String.prototype.charCodeAt;
	let expresiones = 0;
	let lecturas = 0;
	RegExp.prototype.exec = function (this: RegExp, texto: string) {
		expresiones++;
		return exec.call(this, texto);
	};
	String.prototype.charCodeAt = function (this: string, i: number) {
		lecturas++;
		return charCodeAt.call(this, i);
	};
	try {
		const valor = f();
		return { valor, expresiones, lecturas };
	} finally {
		RegExp.prototype.exec = exec;
		String.prototype.charCodeAt = charCodeAt;
	}
}

describe("AUD-33 · quitarComillas da lo mismo que /^\"+|\"+$/g", () => {
	const FIRMA = "A".repeat(86) + "==";

	it.each([
		["vacío", "", ""],
		["una sola comilla", C, ""],
		["sólo comillas", C.repeat(5), ""],
		["sin comillas", FIRMA, FIRMA],
		["una a cada lado", `${C}${FIRMA}${C}`, FIRMA],
		["varias a cada lado", `${C.repeat(3)}${FIRMA}${C.repeat(2)}`, FIRMA],
		["sólo delante", `${C.repeat(2)}abc`, "abc"],
		["sólo detrás", `abc${C.repeat(2)}`, "abc"],
		["en medio, se quedan", `ab${C.repeat(3)}cd`, `ab${C.repeat(3)}cd`],
		["en medio y a los lados", `${C}a${C}b${C}`, `a${C}b`],
		["espacios por fuera, no se quitan", ` ${C}abc${C} `, ` ${C}abc${C} `],
		["espacios por dentro, se quedan", `${C} abc ${C}`, " abc "],
		["comillas simples, no se quitan", "'abc'", "'abc'"],
		["comillas tipográficas, no se quitan", "“abc”", "“abc”"],
	])("%s", (_nombre, entrada, esperado) => {
		expect(conLaExpresion(entrada)).toBe(esperado);
		expect(quitarComillas(entrada)).toBe(esperado);
	});

	it("en todas las cadenas de hasta 8 caracteres de {comilla, x, espacio}", () => {
		const alfabeto = [C, "x", " "];
		let comprobadas = 0;
		const recorrer = (texto: string) => {
			expect(quitarComillas(texto), JSON.stringify(texto)).toBe(conLaExpresion(texto));
			comprobadas++;
			if (texto.length < 8) for (const c of alfabeto) recorrer(texto + c);
		};
		recorrer("");
		// 1 + 3 + 3² + … + 3⁸
		expect(comprobadas).toBe((3 ** 9 - 1) / 2);
	});
});

describe("AUD-33 · quitarComillas es lineal (sin reloj)", () => {
	it("el contador ve una expresión regular cuando la hay", () => {
		// Si el runtime no pasara por el `exec` sustituido, la comprobación de abajo no diría nada.
		const r = contando(() => conLaExpresion(`${C}x${C}`));
		expect(r.valor).toBe("x");
		expect(r.expresiones).toBeGreaterThan(0);
	});

	const N = 200_000;
	it.each([
		// La forma del ataque: ninguna comilla en los extremos y una racha entera en medio.
		["una racha en medio", `x${C.repeat(N)}x`, `x${C.repeat(N)}x`],
		["rachas a los dos lados", `${C.repeat(N)}x${C.repeat(N)}`, "x"],
		["sólo comillas", C.repeat(N), ""],
		["sin comillas", "A".repeat(N), "A".repeat(N)],
	])("%s: el resultado de la expresión, sin ejecutar ninguna y leyendo cada carácter una vez", (_nombre, entrada, esperado) => {
		const r = contando(() => quitarComillas(entrada));
		expect(r.valor === esperado).toBe(true);
		expect(r.expresiones).toBe(0);
		expect(r.lecturas).toBeGreaterThan(0);
		expect(r.lecturas).toBeLessThanOrEqual(entrada.length + 2);
	});
});
