/** @vitest-environment jsdom */
// El histórico de cierres de Cuentas se refresca solo cuando otro equipo cierra la caja.
//
// Era estado de la página: se pedía al entrar y al cerrar o deshacer desde aquí, y un cierre hecho
// en la Main no aparecía en Cuentas de otro equipo hasta salir y volver a entrar. Ahora va por React
// Query con la clave de Cuentas: el aviso de cambios (`sync:cambio` en la Main, `handy:cambio` en la
// Handy) trae `cierres_caja`, `featureKeysPorTablas` lo traduce a `cuentas` y eso lo relee. Se
// sustituye sólo el IPC (`invoke`), y se invalida igual que lo hacen los dos sockets.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { useCierresCaja } from "../../src/features/cuentas/cuentasQueries";
import { featureKeysPorTablas } from "../../src/shared/lib/syncStatements";

const backend = vi.hoisted(() => ({ cierres: [] as { id_cierre: string }[], pedidos: 0 }));

vi.mock("@tauri-apps/api/core", async (original) => ({
	...(await original<object>()),
	invoke: async (comando: string) => {
		if (comando !== "cierre_listar") throw new Error(`comando inesperado: ${comando}`);
		backend.pedidos += 1;
		return backend.cierres;
	},
}));

afterEach(() => {
	cleanup();
	backend.cierres = [];
	backend.pedidos = 0;
});

function Historico({ permitido }: { permitido: boolean }) {
	const q = useCierresCaja(permitido);
	return <ul>{(q.data ?? []).map((c) => <li key={c.id_cierre}>{c.id_cierre}</li>)}</ul>;
}

function montar(permitido: boolean) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
	render(
		<QueryClientProvider client={qc}>
			<Historico permitido={permitido} />
		</QueryClientProvider>,
	);
	return qc;
}

/** Lo que hacen `socketMain.ts` y `socketHandy.ts` con un aviso de cambios. */
async function llegaUnCambio(qc: QueryClient, tablas: string[]) {
	for (const key of featureKeysPorTablas(tablas) ?? []) await qc.invalidateQueries({ queryKey: [key] });
}

it("un cierre hecho en otro equipo aparece sin salir de Cuentas", async () => {
	backend.cierres = [{ id_cierre: "cierre-1" }];
	const qc = montar(true);
	expect(await screen.findByText("cierre-1")).toBeTruthy();

	backend.cierres = [{ id_cierre: "cierre-2" }, { id_cierre: "cierre-1" }];
	await llegaUnCambio(qc, ["Cierres_Caja", "Cierre_Denominaciones"]);
	expect(await screen.findByText("cierre-2")).toBeTruthy();
	expect(backend.pedidos).toBe(2);
});

it("quien no puede cerrar caja ni lo pide, tampoco cuando llega un cierre", async () => {
	const qc = montar(false);
	await llegaUnCambio(qc, ["Cierres_Caja"]);
	await waitFor(() => expect(backend.pedidos).toBe(0));
	expect(screen.queryByRole("listitem")).toBeNull();
});
