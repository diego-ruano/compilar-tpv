/** @vitest-environment jsdom */

// Lo que se carga aparte (el plano) puede no llegar con mala cobertura. Su fallo deja un aviso con
// «Reintentar» en su sitio, no el widget en blanco, y al reintentar se vuelve a intentar pintar.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SiFalla } from "../src/ui";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("si falla una parte del widget", () => {
	it("se ve el aviso con «Reintentar», y al reintentar se pinta lo de dentro", async () => {
		// React también lo cuenta por consola: aquí es lo esperado.
		vi.spyOn(console, "error").mockImplementation(() => {});
		const estado = { roto: true };
		function Plano() {
			if (estado.roto) throw new Error("no ha llegado el plano");
			return <div>El plano</div>;
		}
		const reintentar = vi.fn(() => {
			estado.roto = false;
		});
		render(
			<div>
				<span>Fuera</span>
				<SiFalla aviso="No se ha podido cargar el plano." onReintentar={reintentar}>
					<Plano />
				</SiFalla>
			</div>,
		);

		expect(await screen.findByRole("alert")).toHaveTextContent("No se ha podido cargar el plano.");
		expect(screen.getByText("Fuera")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
		expect(reintentar).toHaveBeenCalledOnce();
		expect(await screen.findByText("El plano")).toBeInTheDocument();
	});
});
