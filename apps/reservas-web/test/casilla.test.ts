// @vitest-environment jsdom
//
// La casilla de Turnstile del SDK (`src/casilla.ts`): el token sólo va a la web de `?origen=`, y sólo
// esa web (desde su ventana) puede pedir otra comprobación.

import { describe, expect, it, vi } from "vitest";

import { MENSAJE, REINICIAR, montarCasilla } from "../src/casilla";

const WEB = "https://www.barpepe.es";

function montar(sobre: { sitekey?: string; destino?: string; cargarFalla?: boolean } = {}) {
	const padre = { postMessage: vi.fn() } as unknown as Window;
	const llamadas: Record<string, (...a: any[]) => void> = {};
	const turnstile = {
		render: vi.fn((_el: HTMLElement, o: Record<string, any>) => {
			Object.assign(llamadas, o);
			return "id-1";
		}),
		reset: vi.fn(),
		remove: vi.fn(),
	};
	const casilla = document.createElement("div");
	montarCasilla({
		casilla,
		sitekey: sobre.sitekey ?? "0xCLAVE",
		destino: sobre.destino ?? WEB,
		ventana: window,
		padre,
		cargar: () => (sobre.cargarFalla ? Promise.reject(new Error("no carga")) : Promise.resolve(turnstile)),
	});
	return { padre, turnstile, llamadas, enviado: (padre.postMessage as any).mock.calls as [any, string][] };
}

const desde = (source: unknown, origin: string, data: unknown) =>
	window.dispatchEvent(new MessageEvent("message", { source: source as any, origin, data }));

describe("la casilla de Turnstile del SDK", () => {
	it("pinta Turnstile con la clave de la página y le pasa el token sólo a su web", async () => {
		const { turnstile, llamadas, enviado } = montar();
		await vi.waitFor(() => expect(turnstile.render).toHaveBeenCalled());
		expect(turnstile.render.mock.calls[0][1]).toMatchObject({ sitekey: "0xCLAVE", language: "es" });

		llamadas.callback("tok-1");
		llamadas["expired-callback"]();
		expect(enviado).toEqual([
			[{ tipo: MENSAJE, token: "tok-1" }, WEB],
			[{ tipo: MENSAJE, token: null }, WEB],
		]);
	});

	it("sólo su web, desde su ventana, puede pedir otra comprobación", async () => {
		const { padre, turnstile } = montar();
		await vi.waitFor(() => expect(turnstile.render).toHaveBeenCalled());
		desde(padre, "https://www.otra.es", { tipo: REINICIAR });
		desde(window, WEB, { tipo: REINICIAR });
		desde(padre, WEB, { tipo: "otra-cosa" });
		expect(turnstile.reset).not.toHaveBeenCalled();
		desde(padre, WEB, { tipo: REINICIAR });
		expect(turnstile.reset).toHaveBeenCalledWith("id-1");
	});

	it("sin clave, sin web o si Turnstile no carga, lo dice como fallo", async () => {
		expect(montar({ sitekey: "" }).enviado).toEqual([[{ tipo: MENSAJE, token: null, fallo: true }, WEB]]);
		expect(montar({ destino: "" }).enviado).toEqual([]);
		const { enviado } = montar({ cargarFalla: true });
		await vi.waitFor(() => expect(enviado).toEqual([[{ tipo: MENSAJE, token: null, fallo: true }, WEB]]));
	});
});
