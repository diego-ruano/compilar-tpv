// test/estadoSync.test.ts
//
// El estado de la conexión con la nube (SYNC-17). Un store de Zustand se prueba sin React: se le
// piden acciones con `getState()` y se mira el resultado.
//
// Lo que hay que fijar aquí es una regla pequeña y fácil de romper sin querer: **repetir el mismo
// estado no reinicia `desde`**. De ese campo sale el "sin conexión desde hace 40 min" que se pinta
// en Configuración, y como el socket reintenta cada pocos segundos, si cada reintento moviera
// `desde` el contador volvería a cero constantemente y no habría forma de saber cuánto lleva caído
// — que es justo lo único que ese texto tiene que responder.

import { describe, it, expect, beforeEach } from "vitest";

import {
	MAX_FALLOS_RECUPERACION,
	useEstadoSync,
} from "../src/shared/stores/useEstadoSync";

/** El store es un singleton de módulo: cada test parte del mismo sitio. */
function reiniciar() {
	useEstadoSync.setState({
		preferencia: "auto",
		hidratada: false,
		datosPerdidos: false,
		trasladoPendiente: false,
		reconciliacionPendiente: false,
		faseRecuperacion: "inactiva",
		errorRecuperacion: null,
		fallosRecuperacion: 0,
		estado: "conectando",
		detalle: null,
		desde: Date.now(),
		pulso: 0,
	});
}

const s = () => useEstadoSync.getState();

describe("useEstadoSync", () => {
	beforeEach(reiniciar);

	it("marcar publica estado y detalle", () => {
		s().marcar("reintentando", "se cayó la red");

		expect(s().estado).toBe("reintentando");
		expect(s().detalle).toBe("se cayó la red");
	});

	it("cambiar de estado mueve `desde`", () => {
		useEstadoSync.setState({ estado: "conectado", desde: 1_000 });

		s().marcar("reintentando");

		expect(s().estado).toBe("reintentando");
		expect(s().desde).toBeGreaterThan(1_000);
	});

	it("repetir el MISMO estado no mueve `desde`", () => {
		// La regla que sostiene el "desde hace X": el socket reintenta cada pocos segundos y cada
		// reintento vuelve a marcar `reintentando`. Si eso reiniciara el contador, el texto mentiría.
		useEstadoSync.setState({ estado: "reintentando", detalle: null, desde: 1_000 });

		s().marcar("reintentando");

		expect(s().desde).toBe(1_000);
	});

	it("el mismo estado con OTRO detalle actualiza el texto pero conserva `desde`", () => {
		// Cambia el error de red, no el hecho de llevar caído desde antes.
		useEstadoSync.setState({ estado: "reintentando", detalle: "timeout", desde: 1_000 });

		s().marcar("reintentando", "sin ticket");

		expect(s().detalle).toBe("sin ticket");
		expect(s().desde).toBe(1_000);
	});

	it("reintentar sube el pulso, que es lo que el socket observa", () => {
		// AppBoot lo dispara en cuanto la licencia deja pasar; el socket lo escucha para intentarlo
		// ya, sin esperar a que venza una espera larga.
		const antes = s().pulso;

		s().reintentar();
		s().reintentar();

		expect(s().pulso).toBe(antes + 2);
	});

	it("tras un traslado de licencia la base es de antes: no se sincroniza y sólo vale la nube", () => {
		s().configurarRecuperacion("transfer_pending");
		// `datosPerdidos` es lo que mantiene cerrado el socket: el outbox de antes no puede subir.
		expect(s().datosPerdidos).toBe(true);
		expect(s().trasladoPendiente).toBe(true);
		expect(s().reconciliacionPendiente).toBe(false);

		// Reconstruida desde la nube, se reconcilia como cualquier otra restauración.
		s().iniciarReconciliacion();
		expect(s().datosPerdidos).toBe(false);
		expect(s().trasladoPendiente).toBe(false);
		expect(s().reconciliacionPendiente).toBe(true);
	});

	it("una base normal no queda marcada como traslado", () => {
		for (const estado of ["ready", "data_missing", "reconciliation_pending"] as const) {
			s().configurarRecuperacion(estado);
			expect(s().trasladoPendiente, estado).toBe(false);
		}
		s().configurarRecuperacion("data_missing");
		expect(s().datosPerdidos).toBe(true);
	});

	it("una restauración no deja de estar bloqueada hasta finalizar la reconciliación", () => {
		s().iniciarReconciliacion();
		expect(s().datosPerdidos).toBe(false);
		expect(s().reconciliacionPendiente).toBe(true);
		expect(s().faseRecuperacion).toBe("esperando_conexion");

		s().finalizarRecuperacion();
		expect(s().reconciliacionPendiente).toBe(false);
		expect(s().faseRecuperacion).toBe("completada");
	});

	it("deja de reintentar sola tras varios ciclos fallidos seguidos", () => {
		s().iniciarReconciliacion();

		for (let i = 1; i < MAX_FALLOS_RECUPERACION; i++) {
			s().marcarFalloRecuperacion("sin conexión");
			expect(s().faseRecuperacion).toBe("error");
		}
		s().marcarFalloRecuperacion("la nube rechazó una operación local");

		// Bloqueada: la pantalla vuelve a ofrecer las alternativas en vez de girar en el vacío.
		expect(s().faseRecuperacion).toBe("bloqueada");
		expect(s().errorRecuperacion).toBe("la nube rechazó una operación local");
		// Y sigue sin poder entrarse: el bloqueo del login no depende de esto.
		expect(s().reconciliacionPendiente).toBe(true);
	});

	it("reintentar borra el bloqueo y pide conexión inmediata", () => {
		s().iniciarReconciliacion();
		for (let i = 0; i < MAX_FALLOS_RECUPERACION; i++) s().marcarFalloRecuperacion("x");
		const antes = s().pulso;

		s().reintentarRecuperacion();

		expect(s().faseRecuperacion).toBe("esperando_conexion");
		expect(s().fallosRecuperacion).toBe(0);
		expect(s().errorRecuperacion).toBeNull();
		expect(s().pulso).toBe(antes + 1);
	});
});
