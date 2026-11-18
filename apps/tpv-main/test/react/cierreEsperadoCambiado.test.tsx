/** @vitest-environment jsdom */
// CAJ-INC-01: la confirmación lleva el esperado que enseñaba la pantalla. Si al confirmar el backend
// recalcula otro (un cobro o un gasto entró mientras se contaba), lo rechaza con un `conflict`, y la
// pantalla lo dice y vuelve a preparar, sin perder el recuento. Corre el modal de verdad; sólo se
// sustituye el IPC (`invoke`).
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import CierreCajaModal from "../../src/features/cuentas/CierreCajaModal";

vi.mock("../../src/shared/lib/conAviso", () => ({ conAviso: (fn: unknown) => fn }));

const backend = vi.hoisted(() => ({
	ventas: 0,
	preparaciones: 0,
	confirmaciones: [] as unknown[],
}));

vi.mock("@tauri-apps/api/core", async (original) => ({
	...(await original<object>()),
	invoke: async (comando: string, args: Record<string, unknown>) => {
		if (comando === "cierre_preparar") {
			backend.preparaciones += 1;
			return {
				desde: "2026-11-13 23:30:00",
				es_primer_cierre: false,
				fondo_inicial: 0,
				ventas_efectivo: backend.ventas,
				gastos_caja: 0,
				esperado: backend.ventas,
				comandas_abiertas: 0,
				umbral_descuadre: 500,
				anulaciones: 0,
				anulaciones_importe: 0,
				historico_pendiente: null,
			};
		}
		if (comando === "cierre_confirmar") {
			backend.confirmaciones.push(args.args);
			// Mientras se contaba entró un cobro de 3 € en efectivo.
			backend.ventas = 300;
			throw { code: "conflict", message: "El esperado ha cambiado mientras contabas: revísalo." };
		}
		throw new Error(`comando inesperado: ${comando}`);
	},
}));

afterEach(() => {
	cleanup();
	backend.ventas = 0;
	backend.preparaciones = 0;
	backend.confirmaciones = [];
});

it("manda el esperado que enseñaba y, si ha cambiado, lo dice y vuelve a preparar", async () => {
	render(<CierreCajaModal open onClose={() => {}} />);
	const cerrar = await screen.findByRole("button", { name: "Cerrar caja" });
	expect(backend.preparaciones).toBe(1);

	fireEvent.click(cerrar);

	expect(await screen.findByText("El esperado ha cambiado mientras contabas: revísalo.")).toBeTruthy();
	expect(backend.confirmaciones).toEqual([expect.objectContaining({ esperado_visto: 0 })]);
	await waitFor(() => expect(backend.preparaciones).toBe(2));
	// Lo que se enseña ahora es la cifra nueva: el descuadre se mira contra ella.
	expect(await screen.findByText(/Contado 0,00\s€ frente a 3,00\s€ esperados/)).toBeTruthy();
});
