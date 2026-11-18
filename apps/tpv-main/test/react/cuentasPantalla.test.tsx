/** @vitest-environment jsdom */
// La pantalla de Cuentas con lo que enseña según el equipo y los permisos. Corre la página de verdad;
// sólo se sustituyen el IPC (`invoke`) y los permisos de la sesión.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import Cuentas from "../../src/app/pages/Cuentas";
import { ToastProvider } from "../../src/shared/toast";

const sesion = vi.hoisted(() => ({ permisos: new Set<string>(), rol: "Administrador" }));
vi.mock("../../src/shared/lib/usePermisos", () => ({
	usePermisos: () => ({ puede: (c: string) => sesion.permisos.has(c), rol: sesion.rol }),
}));

const HOY = new Date().toISOString().slice(0, 10);

vi.mock("@tauri-apps/api/core", async (original) => ({
	...(await original<object>()),
	invoke: async (comando: string) => {
		switch (comando) {
			case "cuentas_get_entradas":
				return {
					filas: [
						{
							id: "p1",
							fecha_hora: `${HOY} 13:00:00`,
							cliente: "Barra",
							metodo: "Efectivo",
							importe: 1250,
							estado: "ACTIVO",
							anulado_en: null,
							anulado_por: null,
							motivo_anulacion: null,
						},
					],
					siguiente: null,
				};
			case "cuentas_get_salidas":
				return {
					filas: [
						{
							id: "g1",
							fecha_hora: HOY,
							tipo_gasto: "Suministros",
							concepto: "Hielo",
							importe: 500,
							proveedor_id: null,
							pagado_con_caja: true,
						},
					],
					siguiente: null,
				};
			case "cuentas_get_resumen":
				return {
					total_entradas: 1250,
					total_salidas: 500,
					total_efectivo: 1250,
					total_tarjeta: 0,
					count_entradas: 1,
					count_salidas: 1,
					count_anuladas: 0,
					total_anulado: 0,
				};
			case "inventario_list_proveedores_mini":
				return [];
			case "cierre_listar":
				return [];
			default:
				throw new Error(`comando inesperado: ${comando}`);
		}
	},
}));

/** Abre Cuentas; lo que devuelve la vuelve a pintar (p. ej. tras cambiar los permisos). */
function abrir(): () => void {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const arbol = () => (
		<QueryClientProvider client={qc}>
			<ToastProvider>
				<Cuentas />
			</ToastProvider>
		</QueryClientProvider>
	);
	const { rerender } = render(arbol());
	return () => rerender(arbol());
}

const TODO = ["cuentas.cobros", "cuentas.gastos", "caja.cerrar"];

beforeEach(() => {
	sesion.permisos = new Set(TODO);
	sesion.rol = "Administrador";
});

afterEach(() => cleanup());

it("no enseña «Enviar a gestoría», que no hacía nada", async () => {
	abrir();
	expect((await screen.findAllByText("Hielo")).length).toBeGreaterThan(0);
	expect(screen.queryByText("Enviar a gestoría")).toBeNull();
});

it("el camarero no ve lo que no puede hacer, ni desactivado", async () => {
	sesion.permisos = new Set(["cuentas.cobros"]);
	sesion.rol = "Camarero";
	abrir();
	expect((await screen.findAllByText("Barra")).length).toBeGreaterThan(0);
	for (const boton of ["Cerrar caja", "Guardar PDF", "Sacar cuenta del día", "Factura de varios tickets"]) {
		expect(screen.queryByRole("button", { name: boton })).toBeNull();
	}
	expect(screen.queryAllByTitle("Factura con NIF (emitir o corregir)")).toHaveLength(0);
	expect(screen.getByText("Los cobros: reimprime un ticket, devuélvelo o dalo de baja.")).toBeTruthy();
});

it("quien sólo cierra caja ve «Cerrar caja» y una cabecera que habla de cierres", async () => {
	sesion.permisos = new Set(["caja.cerrar"]);
	sesion.rol = "Encargado";
	abrir();
	expect(await screen.findByRole("button", { name: "Cerrar caja" })).toBeTruthy();
	expect(screen.queryByRole("button", { name: "Guardar PDF" })).toBeNull();
	expect(screen.getByText("Cierra la caja y repasa los cierres hechos.")).toBeTruthy();
});

it("el editor de un gasto se cierra si se retira el permiso", async () => {
	const repintar = abrir();
	fireEvent.click(await screen.findByRole("button", { name: "Agregar gasto" }));
	expect(await screen.findByText("Añadir gasto")).toBeTruthy();

	sesion.permisos = new Set(["cuentas.cobros"]);
	repintar();

	await waitFor(() => expect(screen.queryByText("Añadir gasto")).toBeNull());
});
