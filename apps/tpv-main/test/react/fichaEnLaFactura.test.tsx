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
const fallaLaLectura = vi.hoisted(() => ({ si: false }));

vi.mock("@tauri-apps/api/core", async (original) => ({
	...(await original<object>()),
	invoke: async (comando: string, args: { args?: unknown }) => {
		llamadas.push({ comando, args: args?.args });
		if (comando === "clientes_para_factura") {
			if (fallaLaLectura.si) throw { code: "internal", message: "La base de datos está ocupada." };
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
	fallaLaLectura.si = false;
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

it("elegir otra ficha sustituye los datos de la primera, sin mezclarlos", async () => {
	formulario(() => true);
	fireEvent.click(await screen.findByRole("button", { name: "Elegir cliente" }));
	fireEvent.change(screen.getByRole("textbox", { name: "Buscar cliente" }), { target: { value: "Paco" } });
	fireEvent.click(await screen.findByRole("button", { name: /Paco/ }));
	expect(campo(/NIF/).value).toBe("B12345674");

	fireEvent.click(screen.getByRole("button", { name: "Elegir cliente" }));
	fireEvent.change(screen.getByRole("textbox", { name: "Buscar cliente" }), { target: { value: "Ana" } });
	fireEvent.click(await screen.findByRole("button", { name: /Ana García/ }));
	expect(campo(/Nombre o razón social/).value).toBe("Ana García");
	expect(campo(/NIF/).value).toBe("");
	expect(campo(/Domicilio/).value).toBe("");
	// Sin NIF no se puede facturar: no sale una factura con el nombre de una y el NIF de otra.
	expect((screen.getByRole("button", { name: "Cobrar y facturar" }) as HTMLButtonElement).disabled).toBe(true);
});

it("«No es esta ficha» se lleva sus datos: elegir otra sin NIF ni domicilio no los mezcla", async () => {
	// La comanda es de la reserva de Paco y el formulario empieza con su ficha; no es él.
	comandaConCliente.id = "c2";
	formulario(() => true);
	await waitFor(() => expect(campo(/NIF/).value).toBe("B12345674"));
	fireEvent.click(screen.getByRole("button", { name: "No es esta ficha" }));
	expect(campo(/Nombre o razón social/).value).toBe("");
	expect(campo(/NIF/).value).toBe("");
	expect(campo(/Domicilio/).value).toBe("");

	fireEvent.click(screen.getByRole("button", { name: "Elegir cliente" }));
	fireEvent.change(screen.getByRole("textbox", { name: "Buscar cliente" }), { target: { value: "Ana" } });
	fireEvent.click(await screen.findByRole("button", { name: /Ana García/ }));
	expect(campo(/Nombre o razón social/).value).toBe("Ana García");
	expect(campo(/NIF/).value).toBe("");
	expect(campo(/Domicilio/).value).toBe("");
	// Nada apunta a la ficha de Paco.
	expect(screen.queryByText(/En la ficha de Paco/)).toBeNull();
	expect((screen.getByRole("button", { name: "Cobrar y facturar" }) as HTMLButtonElement).disabled).toBe(true);
});

it("«No es esta ficha» deja lo que se escribió después de elegirla", async () => {
	comandaConCliente.id = "c2";
	formulario(() => true);
	await waitFor(() => expect(campo(/NIF/).value).toBe("B12345674"));
	fireEvent.change(campo(/Domicilio/), { target: { value: "Calle Nueva 5" } });
	fireEvent.click(screen.getByRole("button", { name: "No es esta ficha" }));
	expect(campo(/NIF/).value).toBe("");
	expect(campo(/Domicilio/).value).toBe("Calle Nueva 5");
});

it("facturar con otro NIF a quien reservó no le cambia el suyo a su ficha", async () => {
	comandaConCliente.id = "c2";
	formulario(() => true);
	await waitFor(() => expect(campo(/NIF/).value).toBe("B12345674"));
	fireEvent.change(campo(/Nombre o razón social/), { target: { value: "Otra Empresa SA" } });
	fireEvent.change(campo(/NIF/), { target: { value: "A58818501" } });
	expect(screen.getByText(/En una ficha nueva con este nombre/)).toBeTruthy();

	fireEvent.click(screen.getByRole("button", { name: "Cobrar y facturar" }));
	await waitFor(() => expect(llamadas.some((l) => l.comando === "clientes_guardar_datos_fiscales")).toBe(true));
	expect(llamadas.find((l) => l.comando === "clientes_guardar_datos_fiscales")?.args).toMatchObject({
		id_cliente: null,
		nif: "A58818501",
	});
});

it("si no se pueden leer las fichas lo dice, con el motivo, y se puede facturar igual", async () => {
	fallaLaLectura.si = true;
	formulario(() => true);
	expect(await screen.findByText(/No se pudieron leer las fichas de cliente/)).toBeTruthy();
	expect(screen.getByText(/La base de datos está ocupada./)).toBeTruthy();
	expect(screen.queryByRole("button", { name: "Elegir cliente" })).toBeNull();
	fireEvent.change(campo(/Nombre o razón social/), { target: { value: "Otra Empresa SA" } });
	fireEvent.change(campo(/NIF/), { target: { value: "A58818501" } });
	expect((screen.getByRole("button", { name: "Cobrar y facturar" }) as HTMLButtonElement).disabled).toBe(false);
});

it("la ficha elegida no sale entre las sugerencias: pulsarla desharía el NIF que se acaba de escribir", async () => {
	comandaConCliente.id = "c2";
	formulario(() => true);
	await waitFor(() => expect(campo(/NIF/).value).toBe("B12345674"));
	// El cliente dicta otro NIF que no es de ninguna ficha; el nombre sigue siendo el de la suya.
	fireEvent.change(campo(/NIF/), { target: { value: "A58818501" } });
	expect(screen.getByText(/En una ficha nueva con este nombre/)).toBeTruthy();
	expect(screen.queryByText("¿Es alguna de estas fichas?")).toBeNull();
	expect(screen.queryByRole("button", { name: /Paco · B12345674/ })).toBeNull();
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
