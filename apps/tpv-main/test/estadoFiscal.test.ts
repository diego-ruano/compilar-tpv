// test/estadoFiscal.test.ts
//
// El store de la escalera de avisos de Veri*factu (FISCAL-01), y en particular la parte que decide
// si este equipo **puede cobrar**.
//
// Lo que se fija aquí es una regla que parece al revés y no lo es: `datosFiscalesCompletos` arranca
// en **`true`**. En casi todo lo demás de este repo se falla del lado pesimista, pero un aviso
// bloqueante que se enseña por no saber todavía la respuesta es peor que no enseñarlo — y hay dos
// situaciones normales en las que no se sabe: el arranque, antes de la primera respuesta, y una
// **Handy**, donde `verifactu_estado` falla porque allí no hay registros de facturación.
//
// Lo pesimista ya está donde importa: sin el NIF y la razón social, `emitir_cobro` corta la
// transacción del cobro pase lo que pase en la interfaz. Este store sólo adelanta el aviso.

import { describe, it, expect, beforeEach, vi } from "vitest";

import { useEstadoFiscal, _resetEstadoFiscal, alMenos } from "../src/shared/stores/useEstadoFiscal";

// El store llama a `verifactuEstado()`, que por debajo es un `invoke` de Tauri. Se sustituye por un
// doble para poder decidir qué contesta cada caso.
const respuesta = vi.hoisted(() => ({ valor: null as unknown, falla: false }));

vi.mock("@tauri-apps/api/core", () => ({
	invoke: async () => {
		if (respuesta.falla) throw new Error("una Handy no tiene registros de facturación");
		return respuesta.valor;
	},
}));

/** Un `EstadoFiscal` con lo mínimo, para no repetir el objeto entero en cada test. */
function estado(extra: Record<string, unknown> = {}) {
	return {
		datos_fiscales_completos: true,
		escalon_aviso: "ninguno",
		antiguedad_pendiente_min: null,
		pendientes: 0,
		...extra,
	};
}

beforeEach(() => {
	_resetEstadoFiscal();
	respuesta.falla = false;
	respuesta.valor = estado();
});

describe("los datos del obligado", () => {
	it("arrancan dándose por buenos, para no bloquear sin saber", () => {
		// Antes de la primera respuesta no se sabe nada. `listo` es `false`, así que el aviso no se
		// pinta de todos modos; lo que esto fija es que el valor por defecto no sea el que dispara
		// un modal bloqueante en cuanto algo ponga `listo` a `true`.
		expect(useEstadoFiscal.getState().datosFiscalesCompletos).toBe(true);
		expect(useEstadoFiscal.getState().listo).toBe(false);
	});

	it("se marcan como incompletos cuando el backend lo dice", async () => {
		respuesta.valor = estado({ datos_fiscales_completos: false });

		await useEstadoFiscal.getState().refrescar();

		expect(useEstadoFiscal.getState().datosFiscalesCompletos).toBe(false);
		expect(useEstadoFiscal.getState().listo).toBe(true);
	});

	it("en una Handy el comando falla y NO se traduce en «faltan los datos»", async () => {
		// Una Handy no tiene registros de facturación: `verifactu_estado` revienta ahí. Tratar ese
		// fallo como «faltan los datos» sacaría un modal que dice que el equipo no puede cobrar en
		// un dispositivo que, efectivamente, no cobra — pero por otro motivo y sin nada que hacer.
		respuesta.falla = true;

		await useEstadoFiscal.getState().refrescar();

		expect(useEstadoFiscal.getState().datosFiscalesCompletos).toBe(true);
		expect(useEstadoFiscal.getState().listo).toBe(true);
	});

	it("un campo ausente se lee como completo, no como incompleto", async () => {
		// Compatibilidad hacia atrás: un backend que todavía no informe el campo no puede dejar el
		// TPV con un modal bloqueante que nadie puede quitar.
		respuesta.valor = estado({ datos_fiscales_completos: undefined });

		await useEstadoFiscal.getState().refrescar();

		expect(useEstadoFiscal.getState().datosFiscalesCompletos).toBe(true);
	});

	it("su reconocimiento es INDEPENDIENTE del de la escalera de atraso", async () => {
		// Son dos problemas distintos: la escalera dice «hay facturas sin remitir», esto dice «el
		// siguiente cobro va a fallar». Reconocer uno no puede silenciar el otro, o el aviso grave
		// desaparecería por haber cerrado el leve.
		respuesta.valor = estado({
			datos_fiscales_completos: false,
			escalon_aviso: "modal_login",
		});
		await useEstadoFiscal.getState().refrescar();

		useEstadoFiscal.getState().reconocer();
		expect(useEstadoFiscal.getState().reconocido).toBe(true);
		expect(useEstadoFiscal.getState().datosReconocidos).toBe(false);

		_resetEstadoFiscal();
		await useEstadoFiscal.getState().refrescar();

		useEstadoFiscal.getState().reconocerDatos();
		expect(useEstadoFiscal.getState().datosReconocidos).toBe(true);
		expect(useEstadoFiscal.getState().reconocido).toBe(false);
	});

	it("vuelven a avisar tras un cierre de sesión", async () => {
		respuesta.valor = estado({ datos_fiscales_completos: false });
		await useEstadoFiscal.getState().refrescar();
		useEstadoFiscal.getState().reconocerDatos();

		// `_resetEstadoFiscal` es lo que corre al cerrar sesión: lo que se reconoció fue «lo he
		// visto hoy», no «no me lo enseñes nunca más».
		_resetEstadoFiscal();

		expect(useEstadoFiscal.getState().datosReconocidos).toBe(false);
	});
});

describe("la escalera de atraso sigue intacta", () => {
	it("ordena los peldaños de menos a más grave", () => {
		expect(alMenos("modal_cobro", "modal_login")).toBe(true);
		expect(alMenos("visible", "notificacion")).toBe(false);
		expect(alMenos("ninguno", "ninguno")).toBe(true);
	});

	it("un escalón que sube invalida el reconocimiento anterior", async () => {
		respuesta.valor = estado({ escalon_aviso: "modal_login" });
		await useEstadoFiscal.getState().refrescar();
		useEstadoFiscal.getState().reconocer();
		expect(useEstadoFiscal.getState().reconocido).toBe(true);

		// Lo que se reconoció era un problema más pequeño que el de ahora.
		respuesta.valor = estado({ escalon_aviso: "modal_cobro" });
		await useEstadoFiscal.getState().refrescar();

		expect(useEstadoFiscal.getState().reconocido).toBe(false);
	});
});
