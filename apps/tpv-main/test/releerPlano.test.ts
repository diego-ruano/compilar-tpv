// test/releerPlano.test.ts
//
// MESAS-02: la meta del plano se relee cuando la propia lectura dice que cambiará con la hora
// (`proximo_cambio_s`), no cada minuto. Sin nada que vaya a cambiar, como mucho cada cuarto de hora.

import { describe, expect, it } from "vitest";

import { cuandoReleerLaMeta, RELECTURA_MAXIMA_META_MS } from "../src/features/mesas/mesasQueries";

const plano = (proximoCambioS: number | null) => ({ porMesa: {}, proximoCambioS });

describe("cuándo se relee la meta del plano", () => {
	it("cuando cambiará, en milisegundos", () => {
		expect(cuandoReleerLaMeta(plano(16))).toBe(16_000);
		expect(cuandoReleerLaMeta(plano(3541))).toBe(3541_000 > RELECTURA_MAXIMA_META_MS ? RELECTURA_MAXIMA_META_MS : 3541_000);
	});

	it("nunca antes de un segundo ni después del tope", () => {
		expect(cuandoReleerLaMeta(plano(0))).toBe(1000);
		expect(cuandoReleerLaMeta(plano(-5))).toBe(1000);
		expect(cuandoReleerLaMeta(plano(24 * 3600))).toBe(RELECTURA_MAXIMA_META_MS);
	});

	it("sin nada que vaya a cambiar solo, o sin lectura todavía, el tope", () => {
		expect(cuandoReleerLaMeta(plano(null))).toBe(RELECTURA_MAXIMA_META_MS);
		expect(cuandoReleerLaMeta(undefined)).toBe(RELECTURA_MAXIMA_META_MS);
		expect(RELECTURA_MAXIMA_META_MS).toBe(15 * 60_000);
	});
});
