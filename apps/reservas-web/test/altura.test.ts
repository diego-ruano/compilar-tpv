/** @vitest-environment jsdom */

// La altura que el widget le pide a `embed.js` es la de su contenido: crece con un paso largo y vuelve
// a bajar con uno corto. jsdom no maqueta: el tamaño del contenido y su observador se simulan.

import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useAvisarAltura } from "../src/altura";

afterEach(() => {
	document.body.innerHTML = "";
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("la altura que pide el widget", () => {
	it("sigue al contenido de #raiz, también cuando encoge", () => {
		const raiz = document.createElement("div");
		raiz.id = "raiz";
		document.body.appendChild(raiz);
		let alto = 900;
		vi.spyOn(raiz, "getBoundingClientRect").mockImplementation(() => ({ height: alto }) as DOMRect);

		const observados: Element[] = [];
		let cambio = () => {};
		vi.stubGlobal(
			"ResizeObserver",
			class {
				constructor(cb: () => void) {
					cambio = cb;
				}
				observe(el: Element) {
					observados.push(el);
				}
				disconnect() {}
			},
		);
		const padre = { postMessage: vi.fn() };
		vi.spyOn(window, "parent", "get").mockReturnValue(padre as unknown as Window);

		renderHook(() => useAvisarAltura());
		expect(observados).toEqual([raiz]);
		expect(padre.postMessage).toHaveBeenLastCalledWith({ tipo: "tpv-reservas-altura", altura: 900 }, "*");

		alto = 412.3;
		cambio();
		expect(padre.postMessage).toHaveBeenLastCalledWith({ tipo: "tpv-reservas-altura", altura: 413 }, "*");

		// Sin cambio de tamaño, no se repite el aviso.
		cambio();
		expect(padre.postMessage).toHaveBeenCalledTimes(2);
	});
});

describe("el ancho del widget no depende de su barra de desplazamiento", () => {
	it("reserva siempre el hueco de la barra", async () => {
		// Con un alto fijo en la web el widget se desplaza por dentro. Si la barra cambiase el ancho, el
		// plano (cuyo alto sale del ancho) encogería, la barra se iría, volvería a crecer… y oscilaría.
		// jsdom no maqueta: se comprueba que la regla sigue en la hoja de estilos.
		const { readFileSync } = await import("node:fs");
		const { resolve } = await import("node:path");
		const css = readFileSync(resolve(process.cwd(), "src/estilos.css"), "utf8");
		expect(css).toMatch(/:root\s*{[^}]*scrollbar-gutter:\s*stable/);
	});
});
