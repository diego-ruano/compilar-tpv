/** @vitest-environment jsdom */
// La ficha de un cliente no ofrece «Publicidad»: era un botón que sólo decía «pendiente de
// implementar». Corre la página de verdad; sólo se sustituyen el IPC (`invoke`) y los permisos.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import Clientes from "../../src/app/pages/Clientes";
import { ToastProvider } from "../../src/shared/toast";

vi.mock("../../src/shared/lib/usePermisos", () => ({
	usePermisos: () => ({ puede: () => true, rol: "Administrador" }),
}));

vi.mock("@tauri-apps/api/core", async (original) => ({
	...(await original<object>()),
	invoke: async (comando: string) => {
		if (comando === "clientes_get_overview") {
			return [
				{
					id_cliente: "c1",
					nombre: "Ana García",
					email: "ana@correo.es",
					telefono: "600111222",
					ultima_reserva_fecha: null,
					ultima_reserva_hora: null,
					ultima_reserva_num_personas: null,
					ultima_reserva_mesa: null,
					total_gastado_stored: 2500,
					total_reservas: 0,
					reservas_pendientes: 0,
				},
			];
		}
		return null;
	},
}));

afterEach(cleanup);

it("la ficha de un cliente tiene «Editar» y no «Publicidad»", async () => {
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<ToastProvider>
				<Clientes />
			</ToastProvider>
		</QueryClientProvider>,
	);
	fireEvent.click(await screen.findByText("Ana García"));

	expect(await screen.findByRole("button", { name: /Editar/ })).toBeTruthy();
	expect(screen.queryByRole("button", { name: /Publicidad/ })).toBeNull();
	expect(screen.queryByText(/pendiente de implementar/)).toBeNull();
});
