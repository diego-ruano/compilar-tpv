/** @vitest-environment jsdom */
// «Cancelar pedido» cancelaba un borrador ya guardado sin preguntar, y cancelado no se puede editar
// ni mandar. Ahora pregunta; un borrador nuevo sin guardar se cierra sin preguntar. Corre la sección
// de verdad; sólo se sustituyen el IPC y el diálogo de confirmación.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import PedidosSection from "../../src/features/proveedores/PedidosSection";
import { ToastProvider } from "../../src/shared/toast";

const ipc = vi.hoisted(() => ({ llamadas: [] as string[], confirmar: vi.fn(async () => false) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: ipc.confirmar }));
vi.mock("@tauri-apps/api/core", async (original) => ({
	...(await original<object>()),
	invoke: async (comando: string) => {
		ipc.llamadas.push(comando);
		if (comando === "pedidos_proveedor_get_page") {
			return {
				pedidos: [
					{
						id_pedido: "p1",
						id_proveedor: null,
						nombre_proveedor: "Bebidas Sur",
						email_destino: "pedidos@bebidassur.es",
						estado: "borrador",
						fecha_creacion: "2027-01-15 10:00:00",
						fecha_envio: null,
						notas: null,
						lineas: [],
					},
				],
				total: 1,
			};
		}
		return null;
	},
}));

afterEach(() => {
	cleanup();
	ipc.llamadas = [];
	ipc.confirmar.mockReset();
});

function pintar() {
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<ToastProvider>
				<PedidosSection proveedores={[]} />
			</ToastProvider>
		</QueryClientProvider>,
	);
}

it("cancelar un borrador guardado pregunta antes, y sin confirmar no se cancela", async () => {
	pintar();
	fireEvent.click(await screen.findByText("Bebidas Sur"));
	ipc.confirmar.mockResolvedValueOnce(false);
	fireEvent.click(await screen.findByRole("button", { name: /Cancelar pedido/ }));
	await waitFor(() => expect(ipc.confirmar).toHaveBeenCalledTimes(1));
	expect(ipc.llamadas).not.toContain("pedidos_proveedor_cambiar_estado");

	ipc.confirmar.mockResolvedValueOnce(true);
	fireEvent.click(screen.getByRole("button", { name: /Cancelar pedido/ }));
	await waitFor(() => expect(ipc.llamadas).toContain("pedidos_proveedor_cambiar_estado"));
});

it("un borrador nuevo sin guardar se cierra sin preguntar", async () => {
	pintar();
	await screen.findByText("Bebidas Sur");
	fireEvent.click(screen.getByRole("button", { name: /Nuevo pedido/ }));
	fireEvent.click(await screen.findByRole("button", { name: /Cancelar pedido/ }));
	await waitFor(() => expect(screen.queryByRole("button", { name: /Cancelar pedido/ })).toBeNull());
	expect(ipc.confirmar).not.toHaveBeenCalled();
	expect(ipc.llamadas).not.toContain("pedidos_proveedor_cambiar_estado");
});
