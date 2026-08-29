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

import { useEstadoSync } from "../src/shared/stores/useEstadoSync";

/** El store es un singleton de módulo: cada test parte del mismo sitio. */
function reiniciar() {
	useEstadoSync.setState({
		preferencia: "auto",
		hidratada: false,
		datosPerdidos: false,
		reconciliacionPendiente: false,
		faseRecuperacion: "inactiva",
		errorRecuperacion: null,
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

	it("una restauración no deja de estar bloqueada hasta finalizar la reconciliación", () => {
		s().iniciarReconciliacion();
		expect(s().datosPerdidos).toBe(false);
		expect(s().reconciliacionPendiente).toBe(true);
		expect(s().faseRecuperacion).toBe("esperando_conexion");

		s().finalizarRecuperacion();
		expect(s().reconciliacionPendiente).toBe(false);
		expect(s().faseRecuperacion).toBe("completada");
	});
});
