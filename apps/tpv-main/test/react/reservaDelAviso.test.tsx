/** @vitest-environment jsdom */
// El aviso de una reserva abre Reservas en su día y señala su tarjeta; sin él, en hoy. Corre la
// pantalla de verdad; sólo se sustituye el IPC.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

import Reservas from "../../src/app/pages/Reservas";
import { ToastProvider } from "../../src/shared/toast";

const datos = vi.hoisted(() => ({ meses: [] as { desde: string; hasta: string }[] }));

const reserva = (id: string, dia: string, nombre: string) => ({
	id_reserva: id,
	id_mesa: "m1",
	dia_ymd: dia,
	hora: "21:00",
	turno: "cena",
	comensales: 2,
	duracion_min: null,
	nota: null,
	estado: "PROXIMA",
	origen: "TPV",
	id_cliente: null,
	nombre_cliente: nombre,
	telefono_cliente: null,
	email_cliente: null,
	id_zona: "z1",
	numero_mesa: "Mesa 1",
	capacidad: 4,
	nombre_zona: "Salón",
});

vi.mock("@tauri-apps/api/core", async (original) => ({
	...(await original<object>()),
	invoke: async (comando: string, args?: { args?: { desde: string; hasta: string } }) => {
		switch (comando) {
			case "reservas_get_meta":
				return { zonas: [], mesas: [] };
			case "reservas_get_mes":
				datos.meses.push(args!.args!);
				return [reserva("r-ana", "2027-03-14", "Ana"), reserva("r-luis", "2027-03-14", "Luis")];
			case "load_layout":
				return [];
			case "mesas_meta_all":
				return { mesas: {}, proximo_cambio_s: null };
			default:
				return null;
		}
	},
}));

afterEach(() => {
	cleanup();
	datos.meses = [];
});

function pintar(state: unknown) {
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<ToastProvider>
				<MemoryRouter initialEntries={[{ pathname: "/Reservas", state }]}>
					<Reservas />
				</MemoryRouter>
			</ToastProvider>
		</QueryClientProvider>,
	);
}

it("con el aviso, abre el mes y el día de la reserva y la señala", async () => {
	pintar({ reserva: { id_reserva: "r-luis", dia_ymd: "2027-03-14" } });

	const luis = await screen.findByText("Luis");
	expect(datos.meses[0]).toEqual({ desde: "2027-03-01", hasta: "2027-03-31" });
	expect(screen.getByText(/RESERVAS 14\/3\/2027/)).toBeTruthy();
	const tarjeta = luis.closest("[data-reserva]") as HTMLElement;
	expect(tarjeta.dataset.reserva).toBe("r-luis");
	expect(tarjeta.getAttribute("aria-current")).toBe("true");
	const ana = (await screen.findByText("Ana")).closest("[data-reserva]") as HTMLElement;
	expect(ana.getAttribute("aria-current")).toBeNull();
});

it("sin un aviso que valga, abre en hoy", async () => {
	pintar({ reserva: { id_reserva: "r-luis", dia_ymd: "2027-02-30" } });

	await vi.waitFor(() => expect(datos.meses.length).toBeGreaterThan(0));
	const hoy = new Date();
	const mes = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}`;
	expect(datos.meses[0].desde).toBe(`${mes}-01`);
});
