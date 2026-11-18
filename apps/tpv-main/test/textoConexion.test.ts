// apps/tpv-main/test/textoConexion.test.ts
//
// Configuración → Conectividad decía «Al día» y que los Handy podían trabajar con 110 cambios de
// este TPV por subir, cuando la nube tiene a los Handy esperando hasta que la Main termina de
// volcarlos.

import { describe, expect, it } from "vitest";

import { textoDeConexion } from "../src/features/configuracion/sections/textoConexion";

describe("el estado de la conexión con la nube", () => {
	it("conectado y sin nada por subir, al día", () => {
		expect(textoDeConexion("conectado", 0)).toMatchObject({ titulo: "Al día", tono: "ok" });
	});

	it("conectado con cambios por subir, subiendo y con los Handy esperando", () => {
		const t = textoDeConexion("conectado", 110);
		expect(t.titulo).toBe("Subiendo cambios (110)…");
		expect(t.desc).toContain("Los Handy esperan a que termine");
		expect(t.tono).toBe("aviso");
	});

	it("mientras no se sabe cuánto queda, lo que diga el estado", () => {
		expect(textoDeConexion("conectado", null).titulo).toBe("Al día");
	});

	it("sin conexión, lo pendiente no cambia el texto", () => {
		expect(textoDeConexion("reintentando", 110).titulo).toBe("Sin conexión");
	});
});
