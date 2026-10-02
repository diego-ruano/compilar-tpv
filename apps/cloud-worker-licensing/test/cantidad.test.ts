// test/cantidad.test.ts
//
// El redondeo de cantidades del worker contra la tabla que comparte con la Main
// (`crates/tpv-domain/src/cantidad_casos.json`). Si un lado cambia de criterio, la Main y la nube
// dejan de guardar el mismo stock (RI-26).

import { describe, expect, it } from "vitest";

import casosJson from "../../../crates/tpv-domain/src/cantidad_casos.json?raw";
import { redondearCantidad } from "../src/lib/cantidad";

const casos = JSON.parse(casosJson) as { redondear: [number, number][] };

describe("el redondeo de cantidades del worker cuadra con la tabla compartida", () => {
	it("la tabla no está vacía", () => {
		expect(casos.redondear.length).toBeGreaterThan(0);
	});

	it.each(casos.redondear)("redondearCantidad(%s) = %s", (x, esperado) => {
		const r = redondearCantidad(x);
		expect(r).toBe(esperado);
		expect(Object.is(r, -0)).toBe(false);
	});

	it("diez raciones de un décimo agotan el kilo", () => {
		let stock = 1;
		for (let i = 0; i < 10; i++) stock = redondearCantidad(stock - 0.1);
		expect(stock).toBe(0);
	});
});
