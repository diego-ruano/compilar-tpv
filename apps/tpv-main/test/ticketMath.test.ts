// apps/tpv-main/test/ticketMath.test.ts
//
// Las cuentas de la vista previa contra las mismas cifras que saca el generador ESC/POS de Rust.
//
// La vista previa es lo que el usuario mira mientras configura el ticket, y contra lo que compara
// cuando algo le parece raro. Si enseña un desglose distinto del que se imprime, uno de los dos
// miente y no hay forma de saber cuál sin una impresora delante.
//
// Los casos de `descuadres` son los mismos que barre `tests_cuadre` en printing.rs. Si aquí se
// cambia el redondeo, allí falla el barrido — y al revés.

import { describe, expect, it } from "vitest";

import {
	agruparLineas,
	desgloseIva,
	totalDe,
	type LineaEntrada,
} from "../src/shared/ticket/ticketMath";

function unidad(nombre: string, precio: number, ivaPercent?: number | null): LineaEntrada {
	return { nombre, precio, ivaPercent };
}

describe("agrupación", () => {
	it("junta unidades idénticas", () => {
		const g = agruparLineas([unidad("Cafe", 1.1), unidad("Cafe", 1.1)]);
		expect(g).toEqual([{ nombre: "Cafe", precio: 1.1, qty: 2, ivaPercent: null }]);
	});

	it("separa por precio y por tipo de IVA", () => {
		expect(agruparLineas([unidad("Cafe", 1.1), unidad("Cafe", 1.2)])).toHaveLength(2);
		expect(agruparLineas([unidad("Vino", 12, 10), unidad("Vino", 12, 21)])).toHaveLength(2);
	});

	it("respeta y suma las cantidades ya contadas", () => {
		const g = agruparLineas([
			{ nombre: "Cafe", precio: 1.3, cantidad: 2 },
			{ nombre: "Cafe", precio: 1.3, cantidad: 3 },
		]);
		expect(g[0].qty).toBe(5);
	});

	it("una cantidad fraccionada conserva el dinero aunque pierda el detalle", () => {
		const g = agruparLineas([{ nombre: "Jamon", precio: 60, cantidad: 0.35 }]);
		expect(g[0].qty).toBe(1);
		expect(totalDe(g)).toBeCloseTo(21, 10);
	});

	it("agrupar no cambia el total", () => {
		const items = [unidad("A", 1.15), unidad("A", 1.15), unidad("B", 0.95), unidad("A", 1.15)];
		const esperado = items.reduce((acc, i) => acc + i.precio, 0);
		expect(totalDe(agruparLineas(items))).toBeCloseTo(esperado, 10);
	});
});

describe("desglose de IVA", () => {
	it("sin tipo propio todo va al tipo del negocio", () => {
		const t = desgloseIva(agruparLineas([unidad("Cafe", 11)]), 10);
		expect(t).toEqual([{ tipo: 10, base: 10, iva: 1 }]);
	});

	it("el tipo de la línea manda sobre el del negocio", () => {
		const t = desgloseIva(agruparLineas([unidad("Vino", 12.1, 21)]), 10);
		expect(t).toEqual([{ tipo: 21, base: 10, iva: 2.1 }]);
	});

	it("un ticket con dos tipos los separa y los ordena", () => {
		const t = desgloseIva(
			agruparLineas([unidad("Cafe", 11), unidad("Vino", 12.1, 21)]),
			10,
		);
		expect(t.map((x) => x.tipo)).toEqual([10, 21]);
		expect(t.reduce((acc, x) => acc + x.base + x.iva, 0)).toBeCloseTo(23.1, 10);
	});

	it("un tipo del cero por ciento no divide entre cero", () => {
		const t = desgloseIva(agruparLineas([unidad("Libro", 10, 0)]), 10);
		expect(t).toEqual([{ tipo: 0, base: 10, iva: 0 }]);
	});

	it("un ticket vacío no inventa tramos", () => {
		expect(desgloseIva([], 10)).toEqual([]);
	});

	it("base más IVA da el total en todos los tipos y en todos los importes", () => {
		// El mismo barrido que hace Rust: los tres tipos de hostelería contra cada importe hasta
		// 200 €. Redondear base y cuota por separado fallaba aquí (0,39 € al 4 % es el primer
		// caso), y el papel decía 0,38 + 0,02 = 0,39.
		const fallos: string[] = [];

		for (const tipo of [4, 10, 21]) {
			for (let c = 1; c <= 20_000; c++) {
				const total = c / 100;
				const [tramo] = desgloseIva(agruparLineas([unidad("x", total)]), tipo);
				const suma = Math.round((tramo.base + tramo.iva) * 100);
				if (suma !== c) {
					fallos.push(`${total.toFixed(2)} al ${tipo}%: ${tramo.base} + ${tramo.iva}`);
					if (fallos.length > 5) break;
				}
			}
		}
		expect(fallos).toEqual([]);
	});

	it("mezclando dos tipos la suma de los tramos sigue siendo el total", () => {
		const fallos: string[] = [];

		for (let a = 1; a <= 140; a++) {
			for (let b = 1; b <= 140; b++) {
				const x = a / 10;
				const y = b / 10;
				const tramos = desgloseIva(
					agruparLineas([unidad("A", x), unidad("B", y, 21)]),
					10,
				);
				const suma = Math.round(tramos.reduce((acc, t) => acc + t.base + t.iva, 0) * 100);
				const total = Math.round((x + y) * 100);
				if (suma !== total) {
					fallos.push(`${x} al 10% + ${y} al 21%: ${suma} != ${total}`);
					if (fallos.length > 5) break;
				}
			}
		}
		expect(fallos).toEqual([]);
	});

	it("los casos que fallaban en Rust dan aquí exactamente lo mismo", () => {
		// Espejo literal: estos son los importes que sacó el barrido de printing.rs cuando la
		// cuota se redondeaba por su cuenta. Si alguno vuelve a divergir, los dos lados se han
		// separado.
		const golden: Array<[number, number, number, number]> = [
			// [total, tipo, base, iva]
			[0.39, 4, 0.38, 0.01],
			[0.91, 4, 0.88, 0.03],
			[1.17, 4, 1.13, 0.04],
			[1.69, 4, 1.63, 0.06],
			[2.21, 4, 2.13, 0.08],
			[2.47, 4, 2.38, 0.09],
		];

		for (const [total, tipo, base, iva] of golden) {
			expect(desgloseIva(agruparLineas([unidad("x", total)]), tipo)).toEqual([
				{ tipo, base, iva },
			]);
		}
	});
});
