// test/reservasWebRecogidas.test.ts
//
// Reservas desde la web (docs/estudios/reservas-web.md §4.5): lo que la Main contesta de lo que la
// agenda le entregó (`POST /v1/reservas-web/recogidas`). Lo escribe la Main, pero llega por la red:
// lo que no tenga la forma de `RecogidasReservaWebInput` no pasa, y el código de una fallida es un
// identificador, nunca un texto que pudiera llevar datos de alguien.

import { describe, expect, it } from "vitest";

import { recogidasSchema } from "../src/domains/reservas_web/reservasWeb.schemas";

const una = (extra: Record<string, unknown> = {}) => ({ id_peticion: "p1", resultado: "registrada", codigo: null, ...extra });

describe("lo que contesta la Main", () => {
	it("acepta los tres resultados, con el código opcional", () => {
		const r = recogidasSchema.safeParse({
			resultados: [una(), una({ resultado: "solapada" }), una({ resultado: "fallida", codigo: "validation" }), { id_peticion: "p2", resultado: "registrada" }],
		});
		expect(r.success).toBe(true);
		expect(r.data!.resultados.map((x) => x.codigo)).toEqual([null, null, "validation", null]);
	});

	it("rechaza lo que no tiene su forma", () => {
		for (const malo of [
			{},
			{ resultados: [una({ resultado: "otra" })] },
			{ resultados: [una({ id_peticion: "" })] },
			{ resultados: [una({ codigo: "Ana no tiene mesa" })] },
			{ resultados: [una({ codigo: 42 })] },
			{ resultados: Array.from({ length: 101 }, () => una()) },
		]) {
			expect(recogidasSchema.safeParse(malo).success, JSON.stringify(malo).slice(0, 80)).toBe(false);
		}
	});
});
