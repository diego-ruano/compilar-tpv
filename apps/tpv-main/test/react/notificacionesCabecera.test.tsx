/** @vitest-environment jsdom */
// La cabecera de Notificaciones en el móvil: el título se partía en dos líneas («Notificacione / s»)
// porque pasaba a la fila de los botones desde `xs` y llevaba `break-words`, y el botón flotante del
// menú (arriba a la izquierda hasta `lg`) tapaba la campana. Corre la página de verdad; sólo se
// sustituye el IPC. El ancho no lo calcula jsdom: se fija lo que lo decide, las clases.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

import Notificaciones from "../../src/app/pages/Notificaciones";
import { useAuth } from "../../src/shared/stores/useAuth";

vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: async () => true }));
vi.mock("@tauri-apps/api/core", async (original) => ({
	...(await original<object>()),
	invoke: async (comando: string) => {
		if (comando === "notificaciones_listar") {
			return [
				{
					id_notificacion: "n1",
					tipo: "reserva",
					severidad: "info",
					titulo: "Nueva reserva",
					cuerpo: null,
					destino_tipo: "rol",
					destino_valor: null,
					accion: null,
					payload: null,
					estado: "activa",
					creada_en: "2027-01-15 10:00:00",
					expira_en: null,
					leida: false,
				},
			];
		}
		return null;
	},
}));

afterEach(() => {
	cleanup();
	useAuth.setState({ idUsuario: "" });
});

it("el título no se parte, las acciones pasan a su lado sólo desde sm y la cabecera deja sitio al menú", async () => {
	useAuth.setState({ idUsuario: "u1" });
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<MemoryRouter>
				<Notificaciones />
			</MemoryRouter>
		</QueryClientProvider>,
	);

	const titulo = await screen.findByRole("heading", { name: "Notificaciones" });
	expect(titulo.className).toContain("whitespace-nowrap");
	expect(titulo.className).not.toContain("break-words");

	const cabecera = titulo.closest("div.rounded-2xl") as HTMLElement;
	expect(cabecera.className).toContain("sm:flex-row");
	expect(cabecera.className).not.toContain("xs:flex-row");
	// El botón flotante del menú ocupa 52 px desde la izquierda de `sm` a `lg`; en el teléfono el
	// menú va en la barra de título y no hace falta el hueco.
	expect(cabecera.className).not.toMatch(/(^| )pl-14( |$)/);
	expect(cabecera.className).toContain("sm:pl-14");
	expect(cabecera.className).toContain("lg:pl-4");

	// «Marcar todas» no se parte; en lo más estrecho queda el icono, con su nombre.
	const marcar = await screen.findByRole("button", { name: "Marcar todas" });
	expect(marcar.className).toContain("whitespace-nowrap");
	expect(marcar.className).not.toContain("break-words");
});
