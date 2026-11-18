// apps/tpv-main/test/textoConexion.test.ts
//
// Configuración → Conectividad decía «Al día» y que los Handy podían trabajar con 110 cambios de
// este TPV por subir, cuando la nube tiene a los Handy esperando hasta que la Main termina de
// volcarlos. Y al revés: decía que los Handy esperaban tras cada venta, o con una operación que se
// reintenta durante horas, cuando ya estaban trabajando. Sólo esperan mientras esta sesión los
// retiene (`handyRetenidas`).

import { describe, expect, it } from "vitest";

import { textoDeConexion } from "../src/features/configuracion/sections/textoConexion";

describe("el estado de la conexión con la nube", () => {
	it("conectado y sin nada por subir, al día", () => {
		expect(textoDeConexion("conectado", 0, false)).toMatchObject({ titulo: "Al día", tono: "ok" });
	});

	it("al conectar, con el atraso por subir, subiendo y con los Handy esperando", () => {
		const t = textoDeConexion("conectado", 110, true);
		expect(t.titulo).toBe("Subiendo cambios (110)…");
		expect(t.desc).toContain("Los Handy esperan a que termine");
		expect(t.tono).toBe("aviso");
	});

	it("con los Handy ya sueltos, lo que sube tras una venta no dice que esperan", () => {
		const t = textoDeConexion("conectado", 1, false);
		expect(t.titulo).toBe("Subiendo cambios (1)…");
		expect(t.desc).not.toContain("esperan");
		expect(t.desc).toContain("pueden trabajar");
		expect(t.tono).toBe("ok");
	});

	it("retenidos sin nada por subir (poniéndose al día con la nube), los Handy esperan", () => {
		const t = textoDeConexion("conectado", 0, true);
		expect(t.titulo).toBe("Poniéndose al día…");
		expect(t.desc).toContain("Los Handy esperan");
	});

	it("mientras no se sabe cuánto queda, lo que diga el estado", () => {
		expect(textoDeConexion("conectado", null, false).titulo).toBe("Al día");
	});

	it("sin conexión, lo pendiente no cambia el texto", () => {
		expect(textoDeConexion("reintentando", 110, true).titulo).toBe("Sin conexión");
	});
});
