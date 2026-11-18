// apps/tpv-main/test/cobrarTodo.test.ts
//
// SYN-INC-05 · «Cobrar todo» con la cuenta cambiando en otro equipo. Mientras se elige el método, la
// réplica recarga el ticket: lo que se haya añadido entra en el cobro y se avisa con el total nuevo.
// Antes la recarga conservaba la selección vieja y se cobraba la cuenta sin la línea nueva.

import { describe, expect, it } from "vitest";

import { pendientesDe, reseleccionarTodo, type LineaCobrable } from "../src/shared/lib/cobrarTodo";
import { deCentimos, eur } from "../src/shared/lib/dinero";

const linea = (id: string, centimos: number, pagado = false): LineaCobrable => ({ id, pagado, precio: deCentimos(centimos) });

describe("«Cobrar todo» tras una recarga", () => {
	const cuenta = [linea("cana", 250), linea("tapa", 400), linea("cafe", 150, true)];

	it("selecciona lo pendiente, no lo cobrado", () => {
		expect(pendientesDe(cuenta)).toEqual(new Set(["cana", "tapa"]));
	});

	it("sin cambios, la misma selección y ningún aviso", () => {
		const { seleccion, aviso } = reseleccionarTodo(new Set(["cana", "tapa"]), cuenta);
		expect(seleccion).toEqual(new Set(["cana", "tapa"]));
		expect(aviso).toBeNull();
	});

	it("una línea añadida en otro equipo entra en el cobro y se avisa con el total nuevo", () => {
		const recargada = [...cuenta, linea("vino", 300)];
		const { seleccion, aviso } = reseleccionarTodo(new Set(["cana", "tapa"]), recargada);
		expect(seleccion).toEqual(new Set(["cana", "tapa", "vino"]));
		expect(aviso).toEqual({ titulo: "Han añadido algo a la cuenta", detalle: `El total es ahora ${eur(deCentimos(950))}.` });
	});

	it("una línea que añade el propio cajero entra en el cobro sin avisarle", () => {
		const recargada = [...cuenta, linea("vino", 300)];
		const { seleccion, aviso } = reseleccionarTodo(new Set(["cana", "tapa"]), recargada, { propia: true });
		expect(seleccion).toEqual(new Set(["cana", "tapa", "vino"]));
		expect(aviso).toBeNull();
	});

	it("una línea quitada en otro equipo sale del cobro y también se avisa", () => {
		const recargada = [linea("cana", 250), linea("cafe", 150, true)];
		const { seleccion, aviso } = reseleccionarTodo(new Set(["cana", "tapa"]), recargada);
		expect(seleccion).toEqual(new Set(["cana"]));
		expect(aviso?.titulo).toBe("La cuenta ha cambiado");
		expect(aviso?.detalle).toBe(`El total es ahora ${eur(deCentimos(250))}.`);
	});

	it("cobrada entera en otro equipo, no queda nada que seleccionar", () => {
		const recargada = cuenta.map((l) => ({ ...l, pagado: true }));
		const { seleccion, aviso } = reseleccionarTodo(new Set(["cana", "tapa"]), recargada);
		expect(seleccion.size).toBe(0);
		expect(aviso?.titulo).toBe("Ya no queda nada por cobrar");
	});
});
