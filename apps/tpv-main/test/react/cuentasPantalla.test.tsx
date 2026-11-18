/** @vitest-environment jsdom */
// La pantalla de Cuentas con lo que enseña según el equipo y los permisos. Corre la página de verdad;
// sólo se sustituyen el IPC (`invoke`) y los permisos de la sesión.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
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

function abrir() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<ToastProvider>
				<Cuentas />
			</ToastProvider>
		</QueryClientProvider>,
	);
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
