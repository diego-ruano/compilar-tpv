// CAJ-INC-02: al dar de baja un cobro por error, sus consumiciones vuelven a la mesa. Si la mesa se
// había vuelto a abrir, se añaden a la cuenta abierta; la pantalla dice adónde han ido.
import { describe, expect, it } from "vitest";

import { avisoDeLineasDevueltas } from "../src/features/cuentas/cuentasApis";

describe("adónde vuelven las líneas de un cobro dado de baja", () => {
	it("a su mesa, reabierta", () => {
		expect(avisoDeLineasDevueltas({ anulado: true, lineas: "su_comanda", mesa: "5" })).toBe(
			"Sus consumiciones vuelven a estar pendientes en la Mesa 5, que se ha reabierto.",
		);
	});

	it("a su ticket de barra, reabierto", () => {
		expect(avisoDeLineasDevueltas({ anulado: true, lineas: "su_comanda", mesa: null })).toBe(
			"Sus consumiciones vuelven a estar pendientes en su ticket, que se ha reabierto.",
		);
	});

	it("a la cuenta que ya estaba abierta en la mesa", () => {
		expect(avisoDeLineasDevueltas({ anulado: true, lineas: "la_abierta", mesa: "Terraza 2" })).toBe(
			"La mesa se había vuelto a abrir: sus consumiciones se han añadido a la cuenta abierta de Terraza 2.",
		);
	});

	it("una devolución o una baja que no se hizo no dicen nada", () => {
		expect(avisoDeLineasDevueltas({ anulado: true, lineas: "no_vuelven", mesa: "5" })).toBeNull();
		expect(avisoDeLineasDevueltas({ anulado: false, lineas: "no_vuelven", mesa: null })).toBeNull();
	});
});
