/** @vitest-environment jsdom */
// Proveedores con sólo `pedidos.gestionar`: «Nuevo proveedor» y los botones de la ficha parecían
// activos (sin estilos `disabled:`) y no hacían nada. Sin `proveedores.gestionar` no se enseñan. Y si
// se lo quitan con el editor del proveedor o el de vincular abiertos, se cierran y lo dice. Corre la
// página de verdad; sólo se sustituyen el IPC, los permisos y el aviso.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

import Proveedores from "../../src/app/pages/Proveedores";

const { permisos, aviso } = vi.hoisted(() => ({
	permisos: new Set<string>(["pedidos.gestionar"]),
	aviso: vi.fn(),
}));
vi.mock("../../src/shared/lib/usePermisos", () => ({
	usePermisos: () => ({ puede: (c: string) => permisos.has(c), rol: "Encargado" }),
}));
vi.mock("../../src/shared/toast", () => ({
	useToast: () => ({ info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: aviso }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn() }));
vi.mock("@tauri-apps/api/core", async (original) => ({
	...(await original<object>()),
	invoke: async (comando: string) => {
		switch (comando) {
			case "proveedores_get_all":
				return [
					{
						id_proveedor: "pr-1",
						nombre_empresa: "Bebidas Sur",
						contacto: null,
						telefono: null,
						email: null,
						cif: null,
						informacion_adicional: null,
						nombre_imagen: null,
						ruta_imagen: null,
					},
				];
			case "proveedores_get_productos":
			case "proveedores_get_categorias":
			case "proveedores_get_productos_all":
				return [];
			case "pedidos_proveedor_get_page":
				return { pedidos: [], total: 0 };
			default:
				return null;
		}
	},
}));

const qc = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const pagina = (cliente: QueryClient) => (
	<QueryClientProvider client={cliente}>
		<MemoryRouter>
			<Proveedores />
		</MemoryRouter>
	</QueryClientProvider>
);

afterEach(() => {
	cleanup();
	aviso.mockReset();
	permisos.clear();
	permisos.add("pedidos.gestionar");
});

it("sin proveedores.gestionar no se enseñan las acciones de gestión", async () => {
	render(pagina(qc()));
	fireEvent.click((await screen.findAllByText("Bebidas Sur"))[0]);
	expect(await screen.findByText("Productos vinculados")).toBeTruthy();
	for (const accion of ["Nuevo proveedor", "Editar perfil", "Vincular productos", "Eliminar proveedor", "Gestionar vínculos"]) {
		expect(screen.queryByRole("button", { name: accion }), accion).toBeNull();
	}
});

it("con el permiso se enseñan, y si se lo quitan con el editor abierto se cierra y lo dice", async () => {
	permisos.add("proveedores.gestionar");
	const cliente = qc();
	const { rerender } = render(pagina(cliente));
	expect(await screen.findByRole("button", { name: /Nuevo proveedor/ })).toBeTruthy();
	fireEvent.click((await screen.findAllByText("Bebidas Sur"))[0]);
	fireEvent.click(await screen.findByRole("button", { name: /Editar perfil/ }));
	expect(await screen.findByText("Editar proveedor")).toBeTruthy();

	// Llega el cambio de permisos (la relectura de `usePermisos`).
	permisos.delete("proveedores.gestionar");
	rerender(pagina(cliente));
	await waitFor(() => expect(screen.queryByText("Editar proveedor")).toBeNull());
	expect(aviso).toHaveBeenCalledWith("Ya no puedes gestionar proveedores", expect.stringContaining("quitado el permiso"));
	expect(screen.queryByRole("button", { name: /Editar perfil/ })).toBeNull();
});
