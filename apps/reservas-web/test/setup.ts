import "@testing-library/jest-dom/vitest";

// jsdom no trae ResizeObserver, con el que el plano mide su hueco: basta con que exista.
if (typeof globalThis.ResizeObserver === "undefined") {
	globalThis.ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
}
