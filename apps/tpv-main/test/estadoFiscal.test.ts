// test/estadoFiscal.test.ts
//
// El store que decide si este equipo **puede cobrar** (FISCAL-01).
//
// Lo que se fija aquí es una regla que parece al revés y no lo es: `datosFiscalesCompletos` arranca
// en **`true`**. En casi todo lo demás de este repo se falla del lado pesimista, pero un aviso
// bloqueante que se enseña por no saber todavía la respuesta es peor que no enseñarlo — y hay dos
// situaciones normales en las que no se sabe: el arranque, antes de la primera respuesta, y una
// **Handy**, que ni lo pregunta porque allí no hay registros de facturación.
//
// Lo pesimista ya está donde importa: sin el NIF y la razón social, `emitir_cobro` corta la
// transacción del cobro pase lo que pase en la interfaz. Este store sólo adelanta el aviso.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { useEstadoFiscal, _resetEstadoFiscal, REFRESCO_MS } from "../src/shared/stores/useEstadoFiscal";
import { useMode } from "../src/shared/stores/useMode";

// El store llama a `verifactuEstado()`, que por debajo es un `invoke` de Tauri. Se sustituye por un
// doble para poder decidir qué contesta cada caso y contar las veces que se pregunta.
const respuesta = vi.hoisted(() => ({ valor: null as unknown, falla: false, preguntas: 0 }));

vi.mock("@tauri-apps/api/core", () => ({
	invoke: async () => {
		respuesta.preguntas += 1;
		if (respuesta.falla) throw new Error("la base está ocupada");
		return respuesta.valor;
	},
}));

/** Un `EstadoFiscal` con lo mínimo, para no repetir el objeto entero en cada test. */
function estado(extra: Record<string, unknown> = {}) {
	return {
		datos_fiscales_completos: true,
		...extra,
	};
}

beforeEach(() => {
	_resetEstadoFiscal();
	respuesta.falla = false;
	respuesta.valor = estado();
	respuesta.preguntas = 0;
	// Lo normal de estos tests es la Main, que es la que pregunta.
	useMode.setState({ mode: "tpv" });
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

	it("si la pregunta falla, NO se traduce en «faltan los datos»", async () => {
		// No haber podido leerlo no es saber que faltan: tratar el fallo como «faltan los datos»
		// sacaría un modal que dice que el equipo no puede cobrar sin que nadie lo haya comprobado.
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

describe("quién pregunta: sólo la Main", () => {
	// El modo del equipo, no la plataforma: un escritorio en modo Handy tampoco pregunta. Los
	// temporizadores del store son los de `window`, que en estos tests (entorno node) no existe.
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal("window", globalThis);
	});
	afterEach(() => {
		_resetEstadoFiscal();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("la Main pregunta al arrancar y después cada dos minutos", async () => {
		useEstadoFiscal.getState().init();
		await vi.advanceTimersByTimeAsync(0);
		expect(respuesta.preguntas).toBe(1);
		expect(useEstadoFiscal.getState().listo).toBe(true);

		await vi.advanceTimersByTimeAsync(2 * REFRESCO_MS);
		expect(respuesta.preguntas).toBe(3);
	});

	it("una Handy no pregunta nunca: ni al arrancar, ni cada dos minutos, ni desde Configuración", async () => {
		// Cada pregunta de una Handy sería un comando que falla —allí no hay registros de
		// facturación— y que `invocar` registra: una cada dos minutos en cada equipo.
		useMode.setState({ mode: "handy" });

		useEstadoFiscal.getState().init();
		await vi.advanceTimersByTimeAsync(3 * REFRESCO_MS);
		await useEstadoFiscal.getState().refrescar();

		expect(respuesta.preguntas).toBe(0);
		// Sin respuesta no hay aviso: `listo` sigue en `false` y los datos, dados por buenos.
		expect(useEstadoFiscal.getState().listo).toBe(false);
		expect(useEstadoFiscal.getState().datosFiscalesCompletos).toBe(true);
	});

	it("mientras no se sabe el modo tampoco se pregunta", async () => {
		for (const modo of ["loading", null] as const) {
			useMode.setState({ mode: modo });
			useEstadoFiscal.getState().init();
			await vi.advanceTimersByTimeAsync(REFRESCO_MS);
		}
		expect(respuesta.preguntas).toBe(0);
	});

	it("un equipo que deja de ser la Main deja de preguntar, aunque el temporizador siga armado", async () => {
		useEstadoFiscal.getState().init();
		await vi.advanceTimersByTimeAsync(0);
		expect(respuesta.preguntas).toBe(1);

		useMode.setState({ mode: "handy" });
		await vi.advanceTimersByTimeAsync(3 * REFRESCO_MS);

		expect(respuesta.preguntas).toBe(1);
	});

	it("un equipo que pasa a ser la Main empieza a preguntar", async () => {
		useMode.setState({ mode: "handy" });
		useEstadoFiscal.getState().init();
		await vi.advanceTimersByTimeAsync(REFRESCO_MS);
		expect(respuesta.preguntas).toBe(0);

		useMode.setState({ mode: "tpv" });
		useEstadoFiscal.getState().init();
		await vi.advanceTimersByTimeAsync(REFRESCO_MS);

		expect(respuesta.preguntas).toBe(2);
	});
});
