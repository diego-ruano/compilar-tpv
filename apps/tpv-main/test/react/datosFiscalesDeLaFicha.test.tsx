/** @vitest-environment jsdom */
// FISCAL-02 · La ficha de un cliente enseña sus datos para facturarle y el formulario los edita: el
// NIF se avisa al escribirlo mal y no se manda, y lo que se guarda lleva los tres campos.
// Corre la página de verdad; sólo se sustituyen el IPC (`invoke`) y los permisos.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import Clientes from "../../src/app/pages/Clientes";
import { ToastProvider } from "../../src/shared/toast";

const llamadas = vi.hoisted(() => [] as { comando: string; args: unknown }[]);
const fichaFalla = vi.hoisted(() => ({ si: false }));

vi.mock("../../src/shared/lib/usePermisos", () => ({
	usePermisos: () => ({ puede: () => true, rol: "Administrador" }),
}));

vi.mock("@tauri-apps/api/core", async (original) => ({
	...(await original<object>()),
	invoke: async (comando: string, args: { args?: unknown }) => {
		llamadas.push({ comando, args: args?.args });
		if (comando === "clientes_get_overview") {
			return [
				{
					id_cliente: "c1",
					nombre: "Paco",
					email: null,
					telefono: null,
					ultima_reserva_fecha: null,
					ultima_reserva_hora: null,
					ultima_reserva_num_personas: null,
					ultima_reserva_mesa: null,
					total_gastado_stored: 0,
					total_reservas: 0,
					reservas_pendientes: 0,
				},
			];
		}
		if (comando === "clientes_get_cliente_form") {
			if (fichaFalla.si) throw { code: "not_found", message: "Ese cliente ya no existe: vuelve a la lista de clientes." };
			return {
				nombre: "Paco",
				email: null,
				telefono: null,
				notas: null,
				nif: "B12345674",
				razon_social: "Comidas Peñalver SL",
				direccion_fiscal: "Calle Mayor 1, Madrid",
			};
		}
		if (comando === "clientes_update_cliente") return true;
		return null;
	},
}));

beforeEach(() => {
	llamadas.length = 0;
	fichaFalla.si = false;
});
afterEach(cleanup);

function pagina() {
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<ToastProvider>
				<Clientes />
			</ToastProvider>
		</QueryClientProvider>,
	);
}

it("la ficha enseña los datos de facturación y el formulario los guarda", async () => {
	pagina();
	fireEvent.click(await screen.findByText("Paco"));
	expect(await screen.findByText("Datos de facturación")).toBeTruthy();
	expect(screen.getByText("Comidas Peñalver SL")).toBeTruthy();
	expect(screen.getByText("B12345674")).toBeTruthy();

	fireEvent.click(screen.getByRole("button", { name: /Editar/ }));
	const nif = (await screen.findByDisplayValue("B12345674")) as HTMLInputElement;

	// Un NIF que no vale se avisa y no se manda.
	fireEvent.change(nif, { target: { value: "12345678A" } });
	expect(screen.getByText(/Ese NIF no es válido/)).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
	await new Promise((r) => setTimeout(r, 0));
	expect(llamadas.some((l) => l.comando === "clientes_update_cliente")).toBe(false);

	fireEvent.change(nif, { target: { value: "a58818501" } });
	fireEvent.change(screen.getByDisplayValue("Calle Mayor 1, Madrid"), { target: { value: "" } });
	fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
	await waitFor(() => expect(llamadas.some((l) => l.comando === "clientes_update_cliente")).toBe(true));
	expect(llamadas.find((l) => l.comando === "clientes_update_cliente")?.args).toMatchObject({
		id_cliente: "c1",
		nif: "A58818501",
		razon_social: "Comidas Peñalver SL",
		direccion_fiscal: undefined,
	});
});

it("si no se pueden leer los datos de facturación, se avisa en vez de parecer que no los tiene", async () => {
	fichaFalla.si = true;
	pagina();
	fireEvent.click(await screen.findByText("Paco"));
	expect(
		await screen.findByText("No se pudieron cargar los datos de facturación del cliente", { selector: "p" }),
	).toBeTruthy();
	expect(screen.queryByText("Datos de facturación")).toBeNull();
});
