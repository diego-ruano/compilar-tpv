/** @vitest-environment jsdom */
// «Tienes una nueva notificación» sale cuando sube el número de no leídas Y avanza la fecha de la más
// reciente que el usuario puede ver (papelera incluida). Restaurar una de la papelera sube el número
// pero no es nueva: antes avisaba igual. Corre el hook de verdad con su consulta; sólo se sustituye
// el IPC.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import type { NoLeidasDto } from "@tpv/contracts";
import { hayUnaNueva, useNotificacionesToast } from "../../src/features/notificaciones/useNotificacionesToast";
import { useAuth } from "../../src/shared/stores/useAuth";
import { ToastProvider } from "../../src/shared/toast";

const globito = vi.hoisted(() => ({ ahora: { count: 1, ultima_creada_en: "2027-01-15 10:00:00" } as NoLeidasDto }));
vi.mock("@tauri-apps/api/core", async (original) => ({
	...(await original<object>()),
	invoke: async (comando: string) => (comando === "notificaciones_no_leidas" ? globito.ahora : null),
}));

afterEach(() => {
	cleanup();
	useAuth.setState({ idUsuario: "" });
});

function Campana() {
	useNotificacionesToast();
	return null;
}

it("decide por el número y por la fecha de la más reciente", () => {
	const n = (count: number, ultima: string | null): NoLeidasDto => ({ count, ultima_creada_en: ultima });
	expect(hayUnaNueva(n(1, "2027-01-15 10:00:00"), n(2, "2027-01-15 10:05:00"))).toBe(true);
	expect(hayUnaNueva(n(0, null), n(1, "2027-01-15 10:05:00"))).toBe(true);
	// Restaurar una de la papelera: sube el número, la fecha no se mueve.
	expect(hayUnaNueva(n(0, "2027-01-15 10:05:00"), n(1, "2027-01-15 10:05:00"))).toBe(false);
	// Leer una: baja el número.
	expect(hayUnaNueva(n(2, "2027-01-15 10:05:00"), n(1, "2027-01-15 10:05:00"))).toBe(false);
	// Un worker anterior no manda la fecha: no se sabe si es nueva.
	expect(hayUnaNueva(n(1, null), n(2, null))).toBe(false);
});

it("restaurar de la papelera no avisa y una nueva sí", async () => {
	useAuth.setState({ idUsuario: "u1" });
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
	render(
		<QueryClientProvider client={qc}>
			<ToastProvider>
				<Campana />
			</ToastProvider>
		</QueryClientProvider>,
	);
	const releer = async () => {
		await act(async () => {
			await qc.invalidateQueries();
			await qc.refetchQueries();
		});
	};
	await releer();

	// La descarta (0) y la restaura (1 otra vez, la misma fecha): no es nueva.
	globito.ahora = { count: 0, ultima_creada_en: "2027-01-15 10:00:00" };
	await releer();
	globito.ahora = { count: 1, ultima_creada_en: "2027-01-15 10:00:00" };
	await releer();
	// El aviso se pinta en el siguiente turno: se le da tiempo antes de mirar que no está.
	await act(() => new Promise((r) => setTimeout(r, 100)));
	expect(screen.queryByText("Tienes una nueva notificación")).toBeNull();

	// Llega una de verdad.
	globito.ahora = { count: 2, ultima_creada_en: "2027-01-15 10:30:00" };
	await releer();
	expect(await screen.findByText("Tienes una nueva notificación")).toBeTruthy();
});
