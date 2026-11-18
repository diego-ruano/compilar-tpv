/** @vitest-environment jsdom */
// La pantalla de Cuentas con lo que enseña según el equipo y los permisos. Corre la página de verdad;
// sólo se sustituyen el IPC (`invoke`) y los permisos de la sesión.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import Cuentas from "../../src/app/pages/Cuentas";
import { useMode } from "../../src/shared/stores/useMode";
import { ToastProvider } from "../../src/shared/toast";

const sesion = vi.hoisted(() => ({ permisos: new Set<string>(), rol: "Administrador" }));
vi.mock("../../src/shared/lib/usePermisos", () => ({
	usePermisos: () => ({ puede: (c: string) => sesion.permisos.has(c), rol: sesion.rol }),
}));

const HOY = new Date().toISOString().slice(0, 10);
const datos = vi.hoisted(() => ({
	cierres: [] as unknown[],
	/** Si está, las listas de entradas y salidas esperan a que se resuelva para contestar. */
	espera: null as Promise<void> | null,
	pedidas: 0,
}));

vi.mock("@tauri-apps/api/core", async (original) => ({
	...(await original<object>()),
	invoke: async (comando: string) => {
		switch (comando) {
			case "cuentas_get_entradas":
				datos.pedidas += 1;
				if (datos.espera) await datos.espera;
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
				if (datos.espera) await datos.espera;
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
						{
							id: "g2",
							fecha_hora: HOY,
							tipo_gasto: "Proveedor",
							concepto: "Merluza",
							importe: 7000,
							proveedor_id: null,
							pagado_con_caja: false,
							proveedor_borrado: "Pescados Norte (borrado)",
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
				return datos.cierres;
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
	useMode.setState({ mode: "tpv" });
	datos.cierres = [];
	datos.espera = null;
	datos.pedidas = 0;
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

it("en la Handy, Cuentas es de consulta: lo dice arriba y no ofrece lo que se rechazaría", async () => {
	useMode.setState({ mode: "handy" });
	abrir();
	expect(await screen.findByText("Cobros, devoluciones, gastos y cierres se hacen en el TPV principal.")).toBeTruthy();
	expect((await screen.findAllByText("Hielo")).length).toBeGreaterThan(0);
	expect(screen.queryByRole("button", { name: "Agregar gasto" })).toBeNull();
	expect(screen.queryByRole("button", { name: "Cerrar caja" })).toBeNull();
	expect(screen.queryByRole("button", { name: "Factura de varios tickets" })).toBeNull();
	for (const titulo of ["Anular", "Devolver (todo o una parte)", "Editar", "Borrar", "Factura con NIF (emitir o corregir)"]) {
		expect(screen.queryAllByTitle(titulo)).toHaveLength(0);
	}
	// El gasto se puede mirar, no guardar.
	fireEvent.click(screen.getAllByTitle("Ver")[0]);
	expect(await screen.findByText("Gasto")).toBeTruthy();
	expect(screen.queryByRole("button", { name: "Guardar cambios" })).toBeNull();
	expect(screen.getByRole("button", { name: "Cerrar" })).toBeTruthy();
});

// El commit que guarda el nombre de un proveedor borrado en su gasto (Cuentas_Gastos.Nombre_Proveedor)
// lo usó en Estadísticas, pero Cuentas enseñaba ese gasto como si no fuera de ningún proveedor.
it("un gasto cuyo proveedor se borró sigue diciendo de quién era", async () => {
	abrir();
	expect((await screen.findAllByText("Merluza")).length).toBeGreaterThan(0);
	expect(screen.getAllByText((_, nodo) => nodo?.childNodes.length === 1 && /Pescados Norte \(borrado\)/.test(nodo.textContent ?? "")).length).toBeGreaterThan(0);
});

it("en la Main no sale la nota de la Handy", async () => {
	abrir();
	expect((await screen.findAllByText("Hielo")).length).toBeGreaterThan(0);
	expect(screen.queryByText(/se hacen en el TPV principal/)).toBeNull();
	expect(screen.getByRole("button", { name: "Agregar gasto" })).toBeTruthy();
});

it("el histórico de cierres: celdas con aire y, en estrecho, una ficha por cierre en vez de la tabla ancha", async () => {
	datos.cierres = [
		{
			id_cierre: "c1",
			fecha_hora: "2026-11-17 23:40:00",
			usuario_nombre: "Marta",
			esperado: 15000,
			contado: 14500,
			descuadre: -500,
			retirado: 14500,
			motivo: "Faltaba cambio",
			reabierto_en: null,
			rect_esperado: null,
			rect_descuadre: null,
		},
	];
	abrir();
	const fichas = await screen.findAllByText("2026-11-17 23:40:00");
	expect(fichas).toHaveLength(2); // la fila de la tabla y la ficha
	const tabla = document.querySelector("table");
	expect(tabla?.className).not.toContain("min-w-");
	for (const celda of Array.from(tabla?.querySelectorAll("th, td") ?? [])) {
		expect(celda.className).toContain("px-2");
	}
	const ficha = fichas.map((n) => n.closest("li")).find((li) => li !== null);
	expect(ficha?.textContent).toContain("Diferencia");
	expect(ficha?.textContent).toContain("Faltaba cambio");
	// La de la tabla sólo se ve en ancho, y la ficha sólo en estrecho.
	expect(tabla?.parentElement?.className).toContain("hidden md:block");
	expect(ficha?.parentElement?.className).toContain("md:hidden");
});

it("al releer las listas no se sustituyen por «Cargando…»: se queda lo de antes hasta que llega lo nuevo", async () => {
	abrir();
	expect((await screen.findAllByText("Barra")).length).toBeGreaterThan(0);
	expect((await screen.findAllByText("Hielo")).length).toBeGreaterThan(0);
	const antes = datos.pedidas;

	let soltar!: () => void;
	datos.espera = new Promise<void>((r) => {
		soltar = r;
	});
	// Otro rango: otra clave, y las dos listas se vuelven a pedir.
	const del = screen.getByText("Del").parentElement?.querySelector("input") as HTMLInputElement;
	fireEvent.change(del, { target: { value: "2026-01-01" } });
	await waitFor(() => expect(datos.pedidas).toBeGreaterThan(antes));

	expect(screen.queryByText("Cargando entradas…")).toBeNull();
	expect(screen.queryByText("Cargando salidas…")).toBeNull();
	expect(screen.getAllByText("Barra").length).toBeGreaterThan(0);
	expect(screen.getAllByText("Hielo").length).toBeGreaterThan(0);

	soltar();
});

it("la primera carga sí enseña «Cargando…», porque todavía no hay nada", async () => {
	let soltar!: () => void;
	datos.espera = new Promise<void>((r) => {
		soltar = r;
	});
	abrir();
	expect(await screen.findByText("Cargando entradas…")).toBeTruthy();
	soltar();
	expect((await screen.findAllByText("Barra")).length).toBeGreaterThan(0);
});
