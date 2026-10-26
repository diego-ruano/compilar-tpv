// El plano del widget: las mesas se ven grandes. Antes se encajaba el contorno entero del salón con
// un zoom máximo de 1,15 en un hueco de 22 rem como mucho, y en un salón con espacio libre las mesas
// salían diminutas. Ahora se encajan las mesas, con más zoom, y el lienzo es tan alto como pidan.

import { describe, expect, it, vi } from "vitest";

import { fitTransform, tamanoDelContenido, type SalonPlano } from "@tpv/plano";

vi.mock("react-konva", () => {
	const Nada = () => null;
	return { Stage: Nada, Layer: Nada, Rect: Nada, Line: Nada, Group: Nada, Text: Nada, Circle: Nada };
});

const { altoDelPlano } = await import("../src/PlanoWidget");

/** Un salón de 2000 × 1200 con dos mesas de 80 × 80 juntas en una esquina. */
const SALON: SalonPlano = {
	id: "s1",
	name: "Interior",
	room: { points: [0, 0, 2000, 0, 2000, 1200, 0, 1200] },
	tables: [
		{ id: "m1", name: "1", x: 100, y: 100, width: 80, height: 80, radius: null, seats: 4, shape: "rect" },
		{ id: "m2", name: "2", x: 300, y: 100, width: 80, height: 80, radius: null, seats: 4, shape: "rect" },
	],
};

describe("encajar el plano", () => {
	it("por defecto, como en la sala de la Main: el salón entero llena el hueco, con un zoom de 3 como mucho", () => {
		expect(tamanoDelContenido(SALON)).toEqual({ ancho: 2000, alto: 1200 });
		// 568 de ancho útil para 2000 de salón, sin encoger más.
		expect(fitTransform(SALON, 600, 400, 16).scale).toBeCloseTo(568 / 2000, 5);
		expect(fitTransform({ ...SALON, room: { points: [] } }, 4000, 4000, 16).scale).toBe(3);
	});

	it("sólo las mesas, con el zoom y el aire que se le den: las mesas llenan el hueco", () => {
		expect(tamanoDelContenido(SALON, true)).toEqual({ ancho: 280, alto: 80 });
		const v = fitTransform(SALON, 600, 400, 16, { soloMesas: true, escalaMaxima: 2.5, holgura: 0.9 });
		// 568 de ancho útil para 280 de mesas: 0,9 · 2,03.
		expect(v.scale).toBeCloseTo(0.9 * (568 / 280), 5);
		// La primera mesa empieza dentro del hueco, no en el contorno del salón.
		expect(100 * v.scale + v.x).toBeGreaterThanOrEqual(16);
		expect(fitTransform(SALON, 4000, 4000, 16, { soloMesas: true, escalaMaxima: 2.5, holgura: 0.9 }).scale).toBe(2.5);
	});

	it("un salón sin mesas se encaja entero aunque se pidan sólo las mesas", () => {
		const vacio = { ...SALON, tables: [] };
		expect(tamanoDelContenido(vacio, true)).toEqual({ ancho: 2000, alto: 1200 });
	});
});

describe("el alto del lienzo", () => {
	it("sigue la forma de las mesas a lo ancho, entre un mínimo y un máximo", () => {
		// Mesas muy apaisadas: el mínimo.
		expect(altoDelPlano(SALON, 600)).toBe(280);
		// Mesas en columna: el máximo.
		const columna = { ...SALON, tables: SALON.tables.map((t, i) => ({ ...t, x: 100, y: 100 + i * 800 })) };
		expect(altoDelPlano(columna, 600)).toBe(640);
		// Mesas en cuadrado (280 × 280) en un hueco de 400: lo que haga falta para que quepan a lo
		// ancho con el 90 % de zoom de `fitTransform`, más los márgenes. 0,9 · 368 + 32 = 363.
		const cuadrado = { ...SALON, tables: [SALON.tables[0], { ...SALON.tables[1], x: 300, y: 300 }] };
		expect(altoDelPlano(cuadrado, 400)).toBe(363);
	});
});
