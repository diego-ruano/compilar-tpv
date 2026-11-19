/** @vitest-environment jsdom */
// Un pedido se llenaba escribiendo cada línea a mano, aunque los productos ya estuvieran en el
// inventario. «Elegir de categorías» los ofrece por categoría y los añade como líneas, que se siguen
// pudiendo cambiar o escribir a mano. Corre la modal de verdad; sólo se sustituye el IPC.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PedidoProveedorDto } from "@tpv/contracts";

import PedidoModal from "../../src/features/proveedores/PedidoModal";

const producto = (id: string, categoria: string, nombre: string, extra: object = {}) => ({
	id_producto: id,
	id_categoria: categoria,
	id_proveedor: null,
	nombre,
	precio_venta: 350,
	stock_actual: 0,
	stock_minimo: 0,
	unidad_medida: null,
	nombre_imagen: null,
	ruta_imagen: null,
	cantidad_pedido_esperada: null,
	ultima_entrada: null,
	...extra,
});

vi.mock("@tauri-apps/api/core", async (original) => ({
	...(await original<object>()),
	invoke: async (comando: string) => {
		if (comando === "proveedores_get_categorias") {
			return [
				{ id_categoria: "bar", nombre: "Bar", nombre_imagen: null, ruta_imagen: null },
				{ id_categoria: "cocina", nombre: "Cocina", nombre_imagen: null, ruta_imagen: null },
			];
		}
		if (comando === "proveedores_get_productos_all") {
			return [
				producto("p-cerveza", "bar", "Cerveza rubia"),
				producto("p-tonica", "bar", "Tónica"),
				producto("p-aceite", "cocina", "Aceite de oliva", { unidad_medida: "l", cantidad_pedido_esperada: 5 }),
			];
		}
		return null;
	},
}));

afterEach(cleanup);

const BORRADOR: PedidoProveedorDto = {
	id_pedido: "p1",
	id_proveedor: null,
	nombre_proveedor: null,
	email_destino: null,
	estado: "borrador",
	fecha_creacion: "2026-11-19 10:00:00",
	fecha_envio: null,
	notas: null,
	lineas: [{ id_linea: "l1", nombre_producto: "Cerveza Rubia", cantidad: 2, precio_unitario: null, unidad: null }],
};

function pintar(onSave = vi.fn(), onClose = vi.fn()) {
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<PedidoModal
				open
				onClose={onClose}
				pedido={BORRADOR}
				proveedores={[]}
				onSave={onSave}
				onCancelarPedido={vi.fn()}
				onMandarPedido={vi.fn()}
			/>
		</QueryClientProvider>,
	);
	return { onSave, onClose };
}

/** La modal del selector: la última que se ha abierto. */
const selector = () => {
	const dialogos = screen.getAllByRole("dialog");
	return within(dialogos[dialogos.length - 1]);
};

it("añade lo elegido de una categoría como líneas, con su unidad y lo que se suele pedir", async () => {
	const { onSave } = pintar();
	fireEvent.click(screen.getByRole("button", { name: /Elegir de categorías/ }));

	// Lo que ya está en el pedido se ve, pero no se repite (sin mirar acentos ni mayúsculas).
	const cerveza = await selector().findByRole("button", { name: /Cerveza rubia/ });
	expect(cerveza).toBeDisabled();
	expect(within(cerveza).getByText("Ya está en el pedido")).toBeInTheDocument();

	fireEvent.click(selector().getByRole("button", { name: "Cocina" }));
	expect(selector().queryByRole("button", { name: /Tónica/ })).toBeNull();
	fireEvent.click(selector().getByRole("button", { name: /Aceite de oliva/ }));
	fireEvent.click(selector().getByRole("button", { name: "Añadir 1" }));

	await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1));
	expect(screen.getByDisplayValue("Aceite de oliva")).toBeInTheDocument();
	expect(screen.getByDisplayValue("l")).toBeInTheDocument();

	fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
	expect(onSave).toHaveBeenCalledTimes(1);
	expect(onSave.mock.calls[0][0].lineas).toEqual([
		BORRADOR.lineas[0],
		expect.objectContaining({ nombre_producto: "Aceite de oliva", cantidad: 5, unidad: "l", precio_unitario: null }),
	]);
});

it("escribir la línea a mano sigue estando, y Escape cierra sólo el selector", async () => {
	const { onClose } = pintar();
	expect(screen.getByRole("button", { name: /Añadir línea/ })).toBeInTheDocument();

	fireEvent.click(screen.getByRole("button", { name: /Elegir de categorías/ }));
	await selector().findByRole("button", { name: /Tónica/ });
	fireEvent.keyDown(window, { key: "Escape" });

	await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1));
	expect(onClose).not.toHaveBeenCalled();
	expect(screen.getByDisplayValue("Cerveza Rubia")).toBeInTheDocument();
});
