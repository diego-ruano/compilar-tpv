/** @vitest-environment jsdom */

// El plano se descarga aparte al llegar al paso 2. Si esa descarga falla, el navegador guarda el fallo
// del `import()` y lo repite a cada intento: lo que lo arregla es volver a cargar la página del widget,
// y eso es lo que ofrece el aviso. Aquí el módulo del plano no llega nunca.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { InfoNegocio, ReservasWeb } from "@altarialights/reservas-web-tpv";
import { recargarPagina } from "../src/pagina";
import Reservar from "../src/Reservar";

vi.mock("../src/PlanoWidget", () => {
	throw new Error("no ha llegado el plano");
});
vi.mock("../src/pagina", () => ({ recargarPagina: vi.fn() }));

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const INFO = {
	ok: true,
	negocio: { nombre: "Bar Pepe", direccion: "", telefono: "", logo: null, razon_social: "", cif: "" },
	hoy: "2026-11-10",
	primer_dia: "2026-11-11",
	ultimo_dia: "2026-12-10",
	dias_abiertos: ["2026-11-20"],
	max_personas: 6,
	duracion_min: 120,
	turnstile: null,
} as unknown as InfoNegocio;

describe("si no llega el plano", () => {
	it("lo dice en su sitio y ofrece volver a cargar el widget", async () => {
		// React también lo cuenta por consola: aquí es lo esperado.
		vi.spyOn(console, "error").mockImplementation(() => {});
		const api = {
			horas: vi.fn(async () => [{ desde: "20:00", hasta: "21:00" }]),
			plano: vi.fn(async () => ({
				completo: true,
				salones: [{ id: "z1", nombre: "Salón", puntos: "[]" }],
				mesas: [{ id: "m1", id_salon: "z1", nombre: "1", forma: "rect", x: 0, y: 0, ancho: 80, alto: 80, radio: null, capacidad: 2, reservable: true }],
			})),
			disponibles: vi.fn(async () => ({ mesas: ["m1"], alternativas: [] })),
		} as unknown as ReservasWeb;
		render(<Reservar api={api} info={INFO} />);

		fireEvent.click(await screen.findByRole("button", { name: "2026-11-20" }));
		await screen.findByDisplayValue("20:00");
		fireEvent.click(screen.getByRole("button", { name: "Ver mesas" }));

		expect(await screen.findByText(/No se ha podido cargar el plano/)).toBeInTheDocument();
		// El resto del paso sigue ahí: no se ha quedado en blanco.
		expect(screen.getByRole("button", { name: "Atrás" })).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Volver a empezar" }));
		expect(recargarPagina).toHaveBeenCalledOnce();
	});
});
