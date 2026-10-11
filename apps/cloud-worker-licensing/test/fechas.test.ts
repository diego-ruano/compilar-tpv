// test/fechas.test.ts
//
// `lib/fechas.ts` (RI-78): una fecha real, no sólo con forma de fecha. Lo que acepta cada schema
// que la usa se contrasta con la Main en `validacionCasos.test.ts`; aquí va lo propio del worker.

import { describe, expect, it } from "vitest";

import { mesQuerySchema } from "../src/domains/reservas/reservas.schemas";
import { esFechaYmd, normalizarDia } from "../src/lib/fechas";

describe("fechas que llegan como texto", () => {
	it("acepta fechas reales en forma canónica", () => {
		for (const valor of ["2026-07-22", "2024-02-29", "2026-12-31", "2026-01-01"]) {
			expect(esFechaYmd(valor), valor).toBe(true);
		}
	});

	it("rechaza formas no canónicas y días que no existen", () => {
		for (const valor of [
			"",
			"2026-7-2",
			"22/07/2026",
			"2026-07-22 ",
			"2026-07-22T10:00",
			"+2026-7-02",
			"2026-13-01",
			"2026-02-30",
			"2026-02-31",
			"2025-02-29",
			"2026-01-0é",
		]) {
			expect(esFechaYmd(valor), JSON.stringify(valor)).toBe(false);
		}
	});

	it("normalizar un día recorta y se queda con la fecha", () => {
		expect(normalizarDia(" 2026-07-22 ")).toBe("2026-07-22");
		expect(normalizarDia("2026-07-22T18:30:00Z")).toBe("2026-07-22");
		expect(normalizarDia("2026-02-31T18:30:00Z")).toBeNull();
		expect(normalizarDia(null)).toBeNull();
		expect(normalizarDia(20260722)).toBeNull();
	});

	it("un día ilegible en una consulta es un fallo de validación, no una excepción", () => {
		// Con un `throw` dentro del `transform`, zod no lo recogía y la ruta contestaba 500.
		const r = mesQuerySchema.safeParse({ desde: "2026-02-31", hasta: "2026-03-31" });
		expect(r.success).toBe(false);
		expect(r.error?.issues.map((i) => i.path.join("."))).toEqual(["desde"]);
		expect(mesQuerySchema.parse({ desde: "2026-03-01", hasta: "2026-03-31" })).toEqual({
			desde: "2026-03-01",
			hasta: "2026-03-31",
		});
	});
});
