// CAJ-INC-02: al dar de baja un cobro por error, sus consumiciones vuelven a la mesa. Si la mesa se
// había vuelto a abrir, se añaden a la cuenta abierta; la pantalla dice adónde han ido.
import { describe, expect, it } from "vitest";

import { avisoDeLineasDevueltas, subtituloCuentas } from "../src/features/cuentas/cuentasApis";

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

	// Un cobro de parte de una cuenta que no se ha cerrado: decía «que se ha reabierto».
	it("a su cuenta, que seguía abierta, sin decir que se ha reabierto", () => {
		expect(avisoDeLineasDevueltas({ anulado: true, lineas: "su_cuenta_abierta", mesa: "5" })).toBe(
			"Sus consumiciones vuelven a estar pendientes en la cuenta de la Mesa 5.",
		);
		expect(avisoDeLineasDevueltas({ anulado: true, lineas: "su_cuenta_abierta", mesa: null })).toBe(
			"Sus consumiciones vuelven a estar pendientes en su ticket.",
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

// En la Handy Cuentas es de consulta: el subtítulo no ofrece devolver, dar de baja ni cerrar.
describe("el subtítulo de Cuentas", () => {
	it("en el TPV principal dice lo que se puede hacer", () => {
		expect(subtituloCuentas({ cobros: true, gastos: false, soloConsulta: false })).toBe(
			"Los cobros: reimprime un ticket, devuélvelo o dalo de baja.",
		);
		expect(subtituloCuentas({ cobros: false, gastos: false, soloConsulta: false })).toBe(
			"Cierra la caja y repasa los cierres hechos.",
		);
	});

	it("en la Handy no promete lo que allí no se hace", () => {
		expect(subtituloCuentas({ cobros: true, gastos: false, soloConsulta: true })).toBe(
			"Los cobros: consúltalos y reimprime un ticket.",
		);
		expect(subtituloCuentas({ cobros: false, gastos: true, soloConsulta: true })).toBe("Los gastos: consúltalos.");
		expect(subtituloCuentas({ cobros: false, gastos: false, soloConsulta: true })).toBe("Repasa los cierres hechos.");
	});
});
