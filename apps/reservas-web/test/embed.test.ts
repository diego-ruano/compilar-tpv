/** @vitest-environment jsdom */

// `embed.js`, el script que se pega en la web del restaurante (§7.3): mete un iframe por hueco, le
// ajusta la altura sólo con los mensajes de su origen y de ese iframe, deja que el CSS del hueco le
// ponga otro alto, y cargarlo dos veces no hace nada más.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Desde la carpeta del proyecto: en jsdom, `import.meta.url` no es una ruta de fichero.
const CODIGO = readFileSync(resolve(process.cwd(), "public/v1/embed.js"), "utf8");
const ORIGEN = "https://tpv-api.test";
const CLAVE = "rw_AAAAAAAAAAAAAAAAAAAAAA";

/** Lo ejecuta como si lo cargara `<script src="…/embed.js">`. */
function cargar(src = `${ORIGEN}/reservas-web/v1/embed.js`) {
	Object.defineProperty(document, "currentScript", { configurable: true, get: () => ({ src }) });
	new Function(CODIGO)();
}

// jsdom no maqueta ni tiene `ResizeObserver`: uno que se dispara a mano.
let observados: Element[] = [];
let avisar: ((cambios: { target: Element }[]) => void) | null = null;
class ObservadorFalso {
	constructor(cb: (cambios: { target: Element }[]) => void) {
		avisar = cb;
	}
	observe(el: Element) {
		observados.push(el);
	}
	disconnect() {}
}
const redimensionar = (el: Element) => avisar?.([{ target: el }]);

/**
 * Lo que mediría el navegador: sin alto en el CSS, el contenido del hueco mide lo que el iframe que
 * lleva dentro; con él, lo que diga el CSS. `clientHeight` incluye el padding (no los bordes).
 */
type Css = { alto?: number; minAlto?: number; maxAlto?: number; padding?: number; oculto?: boolean };
function maquetar(hueco: HTMLElement, css: Css) {
	hueco.style.padding = `${css.padding ?? 0}px`;
	Object.defineProperty(hueco, "clientHeight", {
		configurable: true,
		get: () => {
			if (css.oculto) return 0;
			const delIframe = parseInt(hueco.querySelector("iframe")?.style.height ?? "", 10) || 0;
			let alto = css.alto ?? delIframe;
			if (css.minAlto !== undefined) alto = Math.max(alto, css.minAlto);
			if (css.maxAlto !== undefined) alto = Math.min(alto, css.maxAlto);
			return alto + 2 * (css.padding ?? 0);
		},
	});
	hueco.getClientRects = () => (css.oculto ? [] : [{}]) as unknown as DOMRectList;
	hueco.getBoundingClientRect = () => ({ width: css.oculto ? 0 : 800, height: hueco.clientHeight }) as DOMRect;
}

/** Un hueco con su CSS, y el script cargado. */
function conHueco(css: Css = {}) {
	document.body.innerHTML = `<div data-negocio="${CLAVE}"></div>`;
	const hueco = document.querySelector("div")!;
	maquetar(hueco, css);
	cargar();
	return { hueco, iframe: document.querySelector("iframe")! };
}

function altura(iframe: HTMLIFrameElement, altura: number, origen = ORIGEN, source: unknown = iframe.contentWindow) {
	window.dispatchEvent(
		new MessageEvent("message", { origin: origen, source: source as Window, data: { tipo: "tpv-reservas-altura", altura } }),
	);
}

beforeEach(() => {
	observados = [];
	avisar = null;
	(globalThis as any).ResizeObserver = ObservadorFalso;
});

afterEach(() => {
	document.body.innerHTML = "";
	delete (globalThis as any).ResizeObserver;
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
		// En el flujo: aporta su ancho a un hueco que lo calcule con su contenido.
		expect(iframes[0].style.position).toBe("");
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

	it("la altura sólo la cambia un mensaje de su origen y de su iframe, y con tope", () => {
		const { iframe } = conHueco();
		expect(iframe.style.height).toBe("640px");
		altura(iframe, 900, "https://otra.web");
		expect(iframe.style.height).toBe("640px");
		altura(iframe, 900, ORIGEN, window);
		expect(iframe.style.height).toBe("640px");
		window.dispatchEvent(
			new MessageEvent("message", { origin: ORIGEN, source: iframe.contentWindow as Window, data: { tipo: "otra-cosa", altura: 900 } }),
		);
		expect(iframe.style.height).toBe("640px");

		altura(iframe, 900);
		expect(iframe.style.height).toBe("900px");
		altura(iframe, 99999);
		expect(iframe.style.height).toBe("4000px");
	});
});

describe("el tamaño lo decide el hueco", () => {
	it("sin alto en su CSS, crece con lo que ocupe el widget, también con padding y bordes", () => {
		// Un borde o un padding no son un alto: antes un hueco así se tomaba por uno con alto y el
		// widget se quedaba en esos píxeles.
		const { iframe } = conHueco({ padding: 20 });
		altura(iframe, 900);
		expect(iframe.style.height).toBe("900px");
		altura(iframe, 300);
		expect(iframe.style.height).toBe("300px");
	});

	it("con un alto, lo llena y el widget se desplaza por dentro", () => {
		const { iframe } = conHueco({ alto: 700, padding: 10 });
		expect(iframe.style.height).toBe("700px");
		altura(iframe, 1200);
		expect(iframe.style.height).toBe("700px");
		altura(iframe, 300);
		expect(iframe.style.height).toBe("700px");
	});

	it("con un alto mínimo, lo llena si el widget es más corto y crece si es más largo", () => {
		const { iframe } = conHueco({ minAlto: 500 });
		altura(iframe, 300);
		expect(iframe.style.height).toBe("500px");
		altura(iframe, 900);
		expect(iframe.style.height).toBe("900px");
	});

	it("con un alto máximo, no pasa de él", () => {
		const { iframe } = conHueco({ maxAlto: 500 });
		altura(iframe, 900);
		expect(iframe.style.height).toBe("500px");
		altura(iframe, 300);
		expect(iframe.style.height).toBe("300px");
	});

	it("oculto (en una pestaña) no se queda a cero, y al aparecer coge su alto", () => {
		const css: Css = { alto: 150, oculto: true };
		const { hueco, iframe } = conHueco(css);
		expect(iframe.style.height).toBe("640px");
		altura(iframe, 900);
		expect(iframe.style.height).toBe("900px");
		expect(observados).toContain(hueco);

		css.oculto = false;
		redimensionar(hueco);
		expect(iframe.style.height).toBe("150px");
	});

	it("si su CSS le pone un alto después (llega tarde, cambia con el ancho), lo sigue", () => {
		const css: Css = {};
		const { hueco, iframe } = conHueco(css);
		altura(iframe, 900);
		expect(iframe.style.height).toBe("900px");

		css.alto = 700;
		redimensionar(hueco);
		expect(iframe.style.height).toBe("700px");

		delete css.alto;
		redimensionar(hueco);
		expect(iframe.style.height).toBe("900px");
	});

	it("sin ResizeObserver sigue funcionando con lo que mida al cargar", () => {
		delete (globalThis as any).ResizeObserver;
		const { iframe } = conHueco({ alto: 700 });
		expect(iframe.style.height).toBe("700px");
	});
});
