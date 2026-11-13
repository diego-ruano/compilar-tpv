/** @vitest-environment jsdom */
// DO-02 («encoger y avisar»): tras recuperar los datos de un negocio que nunca había cerrado la caja,
// lo antiguo baja después, y el primer arqueo sólo suma lo que haya bajado. El cierre lo avisa, con
// el progreso, y deja cerrar igual. Corre el modal de verdad; sólo se sustituye el IPC (`invoke`).
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import CierreCajaModal from "../../src/features/cuentas/CierreCajaModal";

const backend = vi.hoisted(() => ({ historico: null as unknown }));

vi.mock("@tauri-apps/api/core", async (original) => ({
	...(await original<object>()),
	invoke: async (comando: string) => {
		if (comando !== "cierre_preparar") throw new Error(`comando inesperado: ${comando}`);
		return {
			desde: null,
			es_primer_cierre: true,
			fondo_inicial: 0,
			ventas_efectivo: 0,
			gastos_caja: 0,
			esperado: 0,
			comandas_abiertas: 0,
			umbral_descuadre: 500,
			anulaciones: 0,
			anulaciones_importe: 0,
			historico_pendiente: backend.historico,
		};
	},
}));

afterEach(() => {
	cleanup();
	backend.historico = null;
});

it("avisa de que el histórico todavía baja, con el progreso, y deja cerrar igual", async () => {
	backend.historico = {
		tablas_pendientes: 3,
		tablas_completadas: 1,
		filas_traidas: 1200,
		tabla_actual: "Cuentas_Gastos",
		ultimo_error: null,
	};
	render(<CierreCajaModal open onClose={() => {}} />);
	expect(await screen.findByText(/Todavía se está descargando el histórico/)).toBeTruthy();
	expect(screen.getByText(/1 de 4 apartados · 25 %/)).toBeTruthy();
	// No bloquea: con el recuento cuadrado, se puede cerrar.
	expect(screen.getByRole("button", { name: "Cerrar caja" })).toBeEnabled();
});

it("sin histórico pendiente no dice nada", async () => {
	render(<CierreCajaModal open onClose={() => {}} />);
	expect(await screen.findByText("Fondo de partida")).toBeTruthy();
	expect(screen.queryByText(/Todavía se está descargando el histórico/)).toBeNull();
});
