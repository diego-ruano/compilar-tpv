/** @vitest-environment jsdom */

// `embed.js`, el script que se pega en la web del restaurante (§7.3): mete un iframe por hueco, le
// ajusta la altura sólo con los mensajes de su origen y de ese iframe, y cargarlo dos veces no hace
// nada más.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Desde la carpeta del proyecto: en jsdom, `import.meta.url` no es una ruta de fichero.
const CODIGO = readFileSync(resolve(process.cwd(), "public/v1/embed.js"), "utf8");
const ORIGEN = "https://tpv-api.test";
const CLAVE = "rw_AAAAAAAAAAAAAAAAAAAAAA";

/** Lo ejecuta como si lo cargara `<script src="…/embed.js">`. */
function cargar(src = `${ORIGEN}/reservas-web/v1/embed.js`) {
	Object.defineProperty(document, "currentScript", { configurable: true, get: () => ({ src }) });
	new Function(CODIGO)();
}

afterEach(() => {
	document.body.innerHTML = "";
});

describe("embed.js", () => {
	it("mete un iframe con el widget en cada hueco con una clave válida", () => {
		document.body.innerHTML = `<div data-negocio="${CLAVE}"></div><div data-negocio="no-vale"></div>`;
		cargar();
		const iframes = document.querySelectorAll("iframe");
		expect(iframes).toHaveLength(1);
		expect(iframes[0].src).toBe(`${ORIGEN}/reservas-web/v1/w/${CLAVE}`);
		expect(iframes[0].title).toBe("Reservar mesa");
		expect(iframes[0].style.width).toBe("100%");
	});

	it("cargarlo dos veces no mete otro", () => {
		document.body.innerHTML = `<div data-negocio="${CLAVE}"></div>`;
		cargar();
		cargar();
		expect(document.querySelectorAll("iframe")).toHaveLength(1);
	});

	it("no deja nada en `window`", () => {
		const antes = new Set(Object.keys(window));
		document.body.innerHTML = `<div data-negocio="${CLAVE}"></div>`;
		cargar();
		expect(Object.keys(window).filter((k) => !antes.has(k))).toEqual([]);
	});

	it("un hueco sin alto: el widget crece con lo que ocupe", () => {
		document.body.innerHTML = `<div data-negocio="${CLAVE}"></div>`;
		cargar();
		const iframe = document.querySelector("iframe")!;
		expect(iframe.style.position).toBe("");
		expect(iframe.style.height).toBe("640px");
	});

	it("un hueco con alto en su CSS: el widget lo llena, y no hace caso a la altura del widget", () => {
		document.body.innerHTML = `<div data-negocio="${CLAVE}" style="width: 900px; height: 700px"></div>`;
		const hueco = document.querySelector("div")!;
		// jsdom no maqueta: lo que mediría el navegador con ese CSS.
		hueco.getBoundingClientRect = () => ({ width: 900, height: 700 }) as DOMRect;
		cargar();
		const iframe = document.querySelector("iframe")!;
		expect(iframe.style.width).toBe("100%");
		expect(iframe.style.height).toBe("100%");
		expect(iframe.style.position).toBe("absolute");
		// Encima del hueco: si no estaba posicionado, se posiciona para que el iframe cuente desde él.
		expect(hueco.style.position).toBe("relative");

		window.dispatchEvent(
			new MessageEvent("message", {
				origin: ORIGEN,
				source: iframe.contentWindow as Window,
				data: { tipo: "tpv-reservas-altura", altura: 1200 },
			}),
		);
		expect(iframe.style.height).toBe("100%");
	});

	it("un hueco ya posicionado no se toca", () => {
		document.body.innerHTML = `<div data-negocio="${CLAVE}" style="position: fixed; inset: 0"></div>`;
		const hueco = document.querySelector("div")!;
		hueco.getBoundingClientRect = () => ({ width: 1024, height: 768 }) as DOMRect;
		cargar();
		expect(hueco.style.position).toBe("fixed");
	});

	it("la altura sólo la cambia un mensaje de su origen y de su iframe, y con tope", () => {
		document.body.innerHTML = `<div data-negocio="${CLAVE}"></div>`;
		cargar();
		const iframe = document.querySelector("iframe")!;
		const enviar = (origin: string, source: unknown, data: unknown) =>
			window.dispatchEvent(new MessageEvent("message", { origin, source: source as Window, data }));

		enviar("https://otra.web", iframe.contentWindow, { tipo: "tpv-reservas-altura", altura: 900 });
		expect(iframe.style.height).toBe("640px");
		enviar(ORIGEN, window, { tipo: "tpv-reservas-altura", altura: 900 });
		expect(iframe.style.height).toBe("640px");
		enviar(ORIGEN, iframe.contentWindow, { tipo: "otra-cosa", altura: 900 });
		expect(iframe.style.height).toBe("640px");

		enviar(ORIGEN, iframe.contentWindow, { tipo: "tpv-reservas-altura", altura: 900 });
		expect(iframe.style.height).toBe("900px");
		enviar(ORIGEN, iframe.contentWindow, { tipo: "tpv-reservas-altura", altura: 99999 });
		expect(iframe.style.height).toBe("4000px");
	});
});
