/** @vitest-environment jsdom */
// FISCAL-02 · El formulario de la factura completa conoce las fichas de cliente en la Main: empieza
// con los datos del cliente de la reserva, ofrece rellenar con los de la ficha cuyo NIF se teclea y
// guarda los datos en la ficha SÓLO después de que el cobro haya entrado. En la Handy no hay nada de
// esto. Corre el formulario de verdad; sólo se sustituye el IPC (`invoke`).
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import DatosFiscalesModal from "../../src/shared/ticket/DatosFiscalesModal";
import { deCentimos } from "../../src/shared/lib/dinero";
import { useMode } from "../../src/shared/stores/useMode";
import { ToastProvider } from "../../src/shared/toast";

const llamadas = vi.hoisted(() => [] as { comando: string; args: unknown }[]);
const comandaConCliente = vi.hoisted(() => ({ id: null as string | null }));

vi.mock("@tauri-apps/api/core", async (original) => ({
	...(await original<object>()),
	invoke: async (comando: string, args: { args?: unknown }) => {
		llamadas.push({ comando, args: args?.args });
		if (comando === "clientes_para_factura") {
			return {
				clientes: [
					{ id_cliente: "c1", nombre: "Ana García", nif: null, razon_social: null, direccion_fiscal: null },
					{ id_cliente: "c2", nombre: "Paco", nif: "B12345674", razon_social: "Comidas Peñalver SL", direccion_fiscal: "Calle Mayor 1" },
				],
				id_cliente_de_la_comanda: comandaConCliente.id,
			};
		}
		if (comando === "clientes_guardar_datos_fiscales") return "c2";
		return null;
	},
}));

beforeEach(() => {
	llamadas.length = 0;
	comandaConCliente.id = null;
	useMode.setState({ mode: "tpv" });
});
afterEach(() => cleanup());

function formulario(onConfirmar: () => boolean | Promise<boolean>) {
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<ToastProvider>
				<DatosFiscalesModal
					open
					onClose={() => {}}
					onConfirmar={onConfirmar}
					importe={deCentimos(1250)}
					limite={deCentimos(300000)}
					obligatorio={false}
					idComanda="k1"
				/>
			</ToastProvider>
		</QueryClientProvider>,
	);
}

const campo = (nombre: RegExp) => screen.getByRole("textbox", { name: nombre }) as HTMLInputElement;

it("empieza con los datos del cliente de la reserva si su ficha los tiene", async () => {
	comandaConCliente.id = "c2";
	formulario(() => true);
	await waitFor(() => expect(campo(/Nombre o razón social/).value).toBe("Comidas Peñalver SL"));
	expect(campo(/NIF/).value).toBe("B12345674");
	expect(campo(/Domicilio/).value).toBe("Calle Mayor 1");
	expect(llamadas.find((l) => l.comando === "clientes_para_factura")?.args).toEqual({ id_comanda: "k1" });
});

it("un NIF que es el de una ficha ofrece rellenar con sus datos", async () => {
	formulario(() => true);
	await screen.findByRole("button", { name: "Elegir cliente" });
	fireEvent.change(campo(/NIF/), { target: { value: "b12345674" } });
	fireEvent.click(await screen.findByRole("button", { name: /Es Paco: rellenar con sus datos/ }));
	expect(campo(/Nombre o razón social/).value).toBe("Comidas Peñalver SL");
	expect(campo(/Domicilio/).value).toBe("Calle Mayor 1");
	// Son los de la ficha: no hay nada nuevo que guardar.
	expect((screen.getByRole("checkbox", { name: /Guardar en la ficha del cliente/ }) as HTMLInputElement).checked).toBe(false);
});

it("los datos nuevos se guardan en la ficha después de cobrar, y no si el cobro no entra", async () => {
	let cobrado = false;
	const onConfirmar = vi.fn(async () => {
		expect(llamadas.some((l) => l.comando === "clientes_guardar_datos_fiscales")).toBe(false);
		return cobrado;
	});
	formulario(onConfirmar);
	await screen.findByRole("button", { name: "Elegir cliente" });
	fireEvent.change(campo(/Nombre o razón social/), { target: { value: "Otra Empresa SA" } });
	fireEvent.change(campo(/NIF/), { target: { value: "A58818501" } });
	const casilla = screen.getByRole("checkbox", { name: /Guardar en la ficha del cliente/ }) as HTMLInputElement;
	expect(casilla.checked).toBe(true);

	fireEvent.click(screen.getByRole("button", { name: "Cobrar y facturar" }));
	await waitFor(() => expect(onConfirmar).toHaveBeenCalledTimes(1));
	await new Promise((r) => setTimeout(r, 0));
	expect(llamadas.some((l) => l.comando === "clientes_guardar_datos_fiscales")).toBe(false);

	cobrado = true;
	fireEvent.click(screen.getByRole("button", { name: "Cobrar y facturar" }));
	await waitFor(() => expect(llamadas.some((l) => l.comando === "clientes_guardar_datos_fiscales")).toBe(true));
	expect(llamadas.find((l) => l.comando === "clientes_guardar_datos_fiscales")?.args).toEqual({
		id_cliente: null,
		nif: "A58818501",
		razon_social: "Otra Empresa SA",
		direccion_fiscal: null,
	});
});

it("en la Handy no se piden fichas ni se ofrece guardarlas", async () => {
	useMode.setState({ mode: "handy" });
	formulario(() => true);
	expect(screen.getByRole("button", { name: "Cobrar y facturar" })).toBeTruthy();
	await new Promise((r) => setTimeout(r, 0));
	expect(screen.queryByRole("button", { name: "Elegir cliente" })).toBeNull();
	expect(screen.queryByRole("checkbox")).toBeNull();
	expect(llamadas).toEqual([]);
});
