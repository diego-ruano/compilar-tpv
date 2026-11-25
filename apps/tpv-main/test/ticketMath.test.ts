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

import { deEuros, sumar } from "../src/shared/lib/dinero";
import {
	agruparLineas,
	desgloseIva,
	eur,
	recortar,
	totalDe,
	type LineaEntrada,
	type TramoIva,
} from "../src/shared/ticket/ticketMath";

/** Los supuestos se escriben en EUROS, que es como se lee un ticket; se comparan en céntimos. */
function unidad(nombre: string, precio: number, iva_percent?: number | null): LineaEntrada {
	return { nombre, precio: deEuros(precio), iva_percent };
}

/** Las bases y las cuotas de todos los tramos del desglose, sumadas. */
const bases = (t: TramoIva[]) => sumar(...t.map((x) => x.base));
const cuotas = (t: TramoIva[]) => sumar(...t.map((x) => x.iva));

describe("agrupación", () => {
	it("junta unidades idénticas", () => {
		const g = agruparLineas([unidad("Cafe", 1.1), unidad("Cafe", 1.1)]);
		expect(g).toEqual([
			{ nombre: "Cafe", precio: 110, qty: 2, iva_percent: null },
		]);
	});

	it("separa por precio y por tipo de IVA", () => {
		expect(agruparLineas([unidad("Cafe", 1.1), unidad("Cafe", 1.2)])).toHaveLength(2);
		expect(agruparLineas([unidad("Vino", 12, 10), unidad("Vino", 12, 21)])).toHaveLength(2);
	});

	it("respeta y suma las cantidades ya contadas", () => {
		const g = agruparLineas([
			{ nombre: "Cafe", precio: deEuros(1.3), cantidad: 2 },
			{ nombre: "Cafe", precio: deEuros(1.3), cantidad: 3 },
		]);
		expect(g[0].qty).toBe(5);
	});

	it("una cantidad fraccionada conserva el dinero aunque pierda el detalle", () => {
		const g = agruparLineas([{ nombre: "Jamon", precio: deEuros(60), cantidad: 0.35 }]);
		expect(g[0].qty).toBe(1);
		// Ya no hace falta tolerancia: 60 EUR x 0,35 son 2100 centimos exactos.
		expect(totalDe(g)).toBe(2100);
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
		expect(t).toEqual([{ tipo: 10, base: 1000, iva: 100 }]);
	});

	it("el tipo de la línea manda sobre el del negocio", () => {
		const t = desgloseIva(agruparLineas([unidad("Vino", 12.1, 21)]), 10);
		expect(t).toEqual([{ tipo: 21, base: 1000, iva: 210 }]);
	});

	it("un ticket con dos tipos los separa y los ordena", () => {
		const t = desgloseIva(
			agruparLineas([unidad("Cafe", 11), unidad("Vino", 12.1, 21)]),
			10,
		);
		expect(t.map((x) => x.tipo)).toEqual([10, 21]);
		expect(bases(t) + cuotas(t)).toBe(2310);
	});

	it("un tipo del cero por ciento no divide entre cero", () => {
		const t = desgloseIva(agruparLineas([unidad("Libro", 10, 0)]), 10);
		expect(t).toEqual([{ tipo: 0, base: 1000, iva: 0 }]);
	});

	it("un ticket vacío no inventa tramos", () => {
		expect(desgloseIva([], 10)).toEqual([]);
	});

	it("con dos tipos, las bases suman 20 € y las cuotas 3,10 €", () => {
		const t = desgloseIva(
			agruparLineas([
				{ nombre: "Cafe", precio: deEuros(11) },
				{ nombre: "Vino", precio: deEuros(12.1), iva_percent: 21 },
			]),
			10,
		);
		expect(bases(t)).toBe(2000);
		expect(cuotas(t)).toBe(310);
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
				const suma = tramo.base + tramo.iva;
				if (suma !== c) {
					fallos.push(`${total.toFixed(2)} al ${tipo}%: ${tramo.base}`);
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
				const suma = bases(tramos) + cuotas(tramos);
				const total = deEuros(x) + deEuros(y);
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
			// [total en euros, tipo, base en céntimos, iva en céntimos]
			[0.39, 4, 38, 1],
			[0.91, 4, 88, 3],
			[1.17, 4, 113, 4],
			[1.69, 4, 163, 6],
			[2.21, 4, 213, 8],
			[2.47, 4, 238, 9],
		];

		for (const [total, tipo, base, iva] of golden) {
			expect(desgloseIva(agruparLineas([unidad("x", total)]), tipo)).toEqual([
				{ tipo, base, iva },
			]);
		}
	});
});

describe("espejo del papel", () => {
	// Estas dos tablas están duplicadas a propósito en `printing/tests.rs`
	// (`tests_espejo_del_frontend`). La vista previa es contra lo que el usuario configura el
	// ticket y contra lo que compara cuando algo le parece raro: si enseña un importe o un
	// recorte distinto del que sale por la impresora, uno de los dos miente y no hay forma de
	// saber cuál sin gastar papel.

	/** `[importe, como se imprime]`. Gemelo de `GOLDEN_EUR` en Rust. */
	const GOLDEN_EUR: Array<[number, string]> = [
		[0, "0,00 €"],
		[1.7, "1,70 €"],
		[12, "12,00 €"],
		[0.005, "0,01 €"],
		// Sin separador de miles: en 32 columnas se confundiría con el decimal. `Intl` lo metía.
		[1234.5, "1234,50 €"],
		[12345.67, "12345,67 €"],
		// Empates: hacia arriba, como los haría cualquiera a mano.
		[1.125, "1,13 €"],
		[2.675, "2,68 €"],
		// Y los que NO son empates aunque lo parezcan (0,145 en binario es 0,14499…).
		[0.145, "0,14 €"],
		// Negativos: una devolución tiene que leerse como tal.
		[-1.5, "-1,50 €"],
		// Un negativo por debajo del céntimo no es "menos cero".
		[-0.001, "0,00 €"],
	];

	it("el importe se ve igual que se imprime", () => {
		for (const [n, esperado] of GOLDEN_EUR) {
			expect(eur(deEuros(n)), `importe ${n}`).toBe(esperado);
		}
	});

	it("el importe no lleva separador de miles ni espacio duro", () => {
		// Los dos vicios de `Intl.NumberFormat` en es-ES, que es de donde venía la divergencia.
		const s = eur(deEuros(12345.67));

		expect(s).not.toContain(".");
		expect(s.codePointAt(s.length - 2)).toBe(0x20); // espacio normal, no U+00A0
	});

	/** `[nombre, importe, columnas, lo que queda del nombre]`. Gemelo de `GOLDEN_RECORTE`. */
	const GOLDEN_RECORTE: Array<[string, string, number, string]> = [
		["Cafe", "1,70 €", 32, "Cafe"],
		// Justo lo que cabe: 32 - 6 - 1 = 25 caracteres.
		["Solomillo al foie con reduccion", "1,70 €", 32, "Solomillo al foie con red"],
		// Con tildes se cuenta en caracteres, no en bytes.
		["Ñoquis a la crème con jamón", "9,99 €", 20, "Ñoquis a la c"],
		// Un emoji es UN carácter y aquí cabe justo: 13 - 6 - 1 = 6. Es el corte exacto que
		// `slice` partía por la mitad, pintando un rombo.
		["Cafe 🍺 grande", "1,70 €", 13, "Cafe 🍺"],
		// Importe más ancho que la línea: no queda nombre, pero no revienta.
		["Cafe", "123456789,00 €", 10, ""],
	];

	it("el nombre se recorta igual que en el papel", () => {
		for (const [nombre, importe, cols, esperado] of GOLDEN_RECORTE) {
			expect(recortar(nombre, importe, cols), `${nombre} en ${cols} columnas`).toBe(esperado);
		}
	});

	it("recortar nunca parte un carácter por la mitad", () => {
		// El síntoma de cortar por unidades UTF-16: aparece el carácter de reemplazo.
		for (let cols = 8; cols <= 20; cols++) {
			const cortado = recortar("Cafe 🍺 grande 🍷 doble", "1,70 €", cols);
			expect(cortado, `con ${cols} columnas`).not.toContain("�");
			expect([...cortado].every((c) => c.codePointAt(0)! < 0xd800 || c.codePointAt(0)! > 0xdfff)).toBe(true);
		}
	});

	it("lo recortado más el importe cabe en la línea", () => {
		// La invariante del maquetado, contada en caracteres como la cuenta Rust.
		for (const [nombre, importe, cols] of GOLDEN_RECORTE) {
			const usado = [...recortar(nombre, importe, cols)].length + [...importe].length;
			// Cuando el importe solo ya no cabe, se conserva el importe y el nombre desaparece.
			if ([...importe].length < cols) {
				expect(usado, `${nombre} en ${cols}`).toBeLessThan(cols);
			}
		}
	});

	it("el recorte se mide contra el importe DE VERDAD, no contra uno cualquiera", () => {
		// Un importe más largo deja menos sitio al nombre: si no fuera así, la línea de un plato
		// caro se saldría del papel.
		const corto = recortar("Solomillo al foie con reduccion", "1,70 €", 32);
		const largo = recortar("Solomillo al foie con reduccion", "1234,50 €", 32);

		expect([...largo].length).toBe([...corto].length - 3);
	});
});
