/** @vitest-environment jsdom */
// CAJ-INC-04: el cierre avisa de lo que queda por cobrar separando mesas y tickets de barra, y sólo
// de lo que de verdad tiene algo pendiente (lo cuenta el backend). Corre el modal de verdad; sólo se
// sustituye el IPC (`invoke`).
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import CierreCajaModal from "../../src/features/cuentas/CierreCajaModal";
import { textoSinCobrar } from "../../src/features/cuentas/cierreApis";

const backend = vi.hoisted(() => ({ mesas: 0, tickets: 0 }));

vi.mock("@tauri-apps/api/core", async (original) => ({
	...(await original<object>()),
	invoke: async (comando: string) => {
		if (comando !== "cierre_preparar") throw new Error(`comando inesperado: ${comando}`);
		return {
			desde: "2026-11-13 23:30:00",
			es_primer_cierre: false,
			fondo_inicial: 0,
			ventas_efectivo: 0,
			gastos_caja: 0,
			esperado: 0,
			mesas_sin_cobrar: backend.mesas,
			tickets_sin_cobrar: backend.tickets,
			umbral_descuadre: 500,
			anulaciones: 0,
			anulaciones_importe: 0,
			historico_pendiente: null,
		};
	},
}));

afterEach(() => {
	cleanup();
	backend.mesas = 0;
	backend.tickets = 0;
});

describe("textoSinCobrar", () => {
	it("nombra mesas y tickets por separado, en singular o en plural", () => {
		expect(textoSinCobrar(2, 1)).toBe("2 mesas y 1 ticket sin cobrar");
		expect(textoSinCobrar(1, 0)).toBe("1 mesa sin cobrar");
		expect(textoSinCobrar(0, 3)).toBe("3 tickets sin cobrar");
		expect(textoSinCobrar(0, 0)).toBeNull();
	});
});

it("avisa de las mesas y los tickets sin cobrar, y deja cerrar", async () => {
	backend.mesas = 2;
	backend.tickets = 1;
	render(<CierreCajaModal open onClose={() => {}} />);
	expect(await screen.findByText(/Hay 2 mesas y 1 ticket sin cobrar\./)).toBeTruthy();
	expect(screen.getByRole("button", { name: "Cerrar caja" })).toBeEnabled();
});

it("sin nada por cobrar no avisa", async () => {
	render(<CierreCajaModal open onClose={() => {}} />);
	expect(await screen.findByText("Fondo de partida")).toBeTruthy();
	expect(screen.queryByText(/sin cobrar/)).toBeNull();
});
