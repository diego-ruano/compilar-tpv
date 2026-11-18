/** @vitest-environment jsdom */
// DO-02 («encoger y avisar»): tras una recuperación que no cabía entera, lo que suma el arqueo (desde
// el último cierre o, en el primero, desde el principio) puede bajar después, y el arqueo sólo suma
// lo que haya bajado. El cierre lo avisa, con el progreso, y deja cerrar igual. Corre el modal de
// verdad; sólo se sustituye el IPC (`invoke`).
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import CierreCajaModal from "../../src/features/cuentas/CierreCajaModal";

const backend = vi.hoisted(() => ({ historico: null as unknown, desde: null as string | null }));

vi.mock("@tauri-apps/api/core", async (original) => ({
	...(await original<object>()),
	invoke: async (comando: string) => {
		if (comando !== "cierre_preparar") throw new Error(`comando inesperado: ${comando}`);
		return {
			desde: backend.desde,
			es_primer_cierre: backend.desde === null,
			fondo_inicial: 0,
			ventas_efectivo: 0,
			gastos_caja: 0,
			esperado: 0,
			mesas_sin_cobrar: 0,
			tickets_sin_cobrar: 0,
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
	backend.desde = null;
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
	expect(screen.getByText(/suma desde el principio/)).toBeTruthy();
	// No bloquea: con el recuento cuadrado, se puede cerrar.
	expect(screen.getByRole("button", { name: "Cerrar caja" })).toBeEnabled();
});

it("con un cierre anterior dice que suma desde él, y deja cerrar igual", async () => {
	// Lo que había desde el último cierre no cupo en la recuperación y aún baja.
	backend.desde = "2026-11-13 23:30:00";
	backend.historico = {
		tablas_pendientes: 2,
		tablas_completadas: 2,
		filas_traidas: 5000,
		tabla_actual: "Pagos",
		ultimo_error: null,
	};
	render(<CierreCajaModal open onClose={() => {}} />);
	expect(await screen.findByText(/Todavía se está descargando el histórico/)).toBeTruthy();
	expect(screen.getByText(/suma desde el último cierre/)).toBeTruthy();
	expect(screen.getByRole("button", { name: "Cerrar caja" })).toBeEnabled();
});

it("sin histórico pendiente no dice nada", async () => {
	render(<CierreCajaModal open onClose={() => {}} />);
	expect(await screen.findByText("Fondo de partida")).toBeTruthy();
	expect(screen.queryByText(/Todavía se está descargando el histórico/)).toBeNull();
});
