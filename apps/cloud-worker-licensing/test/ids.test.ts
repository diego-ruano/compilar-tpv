// test/ids.test.ts
//
// RI-59: los ids del worker son UUIDv7 y crecen, también dentro de una misma petición, donde
// workerd deja `Date.now()` quieto. Hay consultas que ordenan por la clave como «lo más reciente».

import { afterEach, describe, expect, it, vi } from "vitest";

import { nuevoId } from "../src/lib/ids";

// El generador no retrocede nunca (ni ante un reloj que va hacia atrás), así que los relojes
// falsos van por delante del real, que ya han usado los tests anteriores.
const FUTURO = Date.UTC(2100, 0, 1);

const FORMATO = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
	vi.restoreAllMocks();
});

describe("nuevoId", () => {
	it("es un UUIDv7 en minúsculas, como el to_string() de Rust", () => {
		for (let i = 0; i < 100; i++) expect(nuevoId()).toMatch(FORMATO);
	});

	it("lleva los milisegundos del reloj en los 48 bits altos", () => {
		const ms = FUTURO + 10_000_000;
		vi.spyOn(Date, "now").mockReturnValue(ms);
		const id = nuevoId();
		expect(parseInt(id.replace(/-/g, "").slice(0, 12), 16)).toBe(ms);
	});

	it("crece aunque el reloj no se mueva, también al desbordar el contador", () => {
		vi.spyOn(Date, "now").mockReturnValue(FUTURO + 20_000_000);
		const ids = Array.from({ length: 10_000 }, () => nuevoId());
		const ordenados = [...ids].sort();
		expect(ids).toEqual(ordenados);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("no retrocede si el reloj va hacia atrás", () => {
		const base = FUTURO + 30_000_000;
		const reloj = vi.spyOn(Date, "now").mockReturnValue(base);
		const antes = nuevoId();
		reloj.mockReturnValue(base - 5_000);
		expect(nuevoId() > antes).toBe(true);
	});
});
