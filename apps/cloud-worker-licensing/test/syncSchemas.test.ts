// test/syncSchemas.test.ts
//
// ARQ-06: la permisividad de estas rutas es contrato de recuperación, no falta de validación.

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import * as z from "zod";

import {
	changesSchema,
	historicoSchema,
	saludSyncSchema,
	verificarClavesPorPaginasSchema,
	verificarFilasSchema,
	verificarResumenSchema,
} from "../src/domains/sync/sync.schemas";
import { cuerpoTolerante } from "../src/lib/validacion";

describe("schemas totales de sync", () => {
	it("conservan defaults, coerciones y topes de changes e histórico", () => {
		expect(changesSchema.parse({ since: "pepino", limit: 0 })).toEqual({ since: 0, limit: 500 });
		expect(changesSchema.parse({ since: -3, limit: "99999" })).toEqual({ since: 0, limit: 1_000 });
		expect(changesSchema.parse({ limit: -8 })).toEqual({ since: 0, limit: 1 });

		expect(historicoSchema.parse({ tabla: 12, cursor: "mal", limite: 0 })).toEqual({
			tabla: "12",
			cursor: 0,
			limite: 1_000,
		});
		// El tope de una página del histórico (`HISTORICO_MAX_FILAS`): lo que pide la Main en calma.
		expect(historicoSchema.parse({ tabla: "Comandas", limite: 99_999 }).limite).toBe(10_000);
		expect(historicoSchema.parse({ tabla: "Comandas", limite: 2_000 }).limite).toBe(2_000);
	});

	it("los cuerpos del contraste: lo que no es lo que se espera cae a su valor por defecto, y los topes los pone el servidor", () => {
		expect(verificarResumenSchema.parse({ checkpoint: 40 })).toEqual({ checkpoint: 40 });
		for (const malo of [undefined, "40", -1, 1.5, Number.MAX_SAFE_INTEGER + 2, null]) {
			expect(verificarResumenSchema.parse({ checkpoint: malo }).checkpoint, String(malo)).toBeNull();
		}

		const filas = verificarFilasSchema.parse({
			tabla: "Zonas",
			desde: "x".repeat(100),
			cubos: 16,
			pedir: Array.from({ length: 1_000 }, (_, i) => i),
			cursor: -5,
		});
		expect(filas.desde).toHaveLength(40);
		expect(filas.pedir).toHaveLength(256);
		expect(filas.cursor).toBe(0);
		expect(verificarFilasSchema.parse({})).toMatchObject({ tabla: "", desde: "", pedir: [], cursor: 0 });
		expect(Number.isNaN(verificarFilasSchema.parse({ cubos: "16" }).cubos)).toBe(true);

		expect(verificarClavesPorPaginasSchema.parse({ tabla: "Zonas", limite: 10_000_000 }).limite).toBe(20_000);
		expect(verificarClavesPorPaginasSchema.parse({ tabla: "Zonas", limite: 0 }).limite).toBe(10_000);
		expect(verificarClavesPorPaginasSchema.parse({ tabla: "Zonas", cursor: "z1" }).cursor).toBeNull();
		expect(verificarClavesPorPaginasSchema.parse({ tabla: "Zonas", cursor: [1, 2, 3, 4, 5, 6, 7, 8, 9] }).cursor).toHaveLength(8);
	});

	it("recorta y normaliza el informe de salud sin volverlo estricto", () => {
		const descuadres = Array.from({ length: 55 }, (_, i) => ({
			tabla: `Tabla-${i}-${"x".repeat(80)}`,
			faltan: String(i),
		}));
		const parsed = saludSyncSchema.parse({
			descuadres,
			apartadas: "3",
			reparadas: null,
			ventana_omitida: "false",
		});
		expect(parsed.descuadres).toHaveLength(50);
		expect(parsed.descuadres[0].tabla).toHaveLength(64);
		expect(parsed.apartadas).toBe(3);
		expect(parsed.reparadas).toBe(0);
		expect(parsed.ventana_omitida).toBe(true);
		// Lo que añade el contraste por resúmenes; con un cliente anterior, sus valores por defecto.
		expect(parsed).toMatchObject({ borradas: 0, aplazado: false, filas_examinadas: 0, tablas_sin_comparar: [] });
		const nuevo = saludSyncSchema.parse({
			borradas: 2,
			aplazado: true,
			filas_examinadas: 31,
			tablas_sin_comparar: ["Zonas", "Mesas; DROP TABLE x", 7, ...Array.from({ length: 60 }, (_, i) => `T${i}`)],
		});
		expect(nuevo).toMatchObject({ borradas: 2, aplazado: true, filas_examinadas: 31 });
		expect(nuevo.tablas_sin_comparar).toHaveLength(50);
		expect(nuevo.tablas_sin_comparar.slice(0, 2)).toEqual(["Zonas", "T0"]);
		// PROD-06: ausente es «encendida», que es lo que manda un cliente anterior.
		expect(parsed.reparacion_apagada).toBe(false);
		expect(saludSyncSchema.parse({ reparacion_apagada: true }).reparacion_apagada).toBe(true);
	});
});

describe("cuerpoTolerante", () => {
	it("convierte un JSON roto o sin Content-Type en el valor por defecto", async () => {
		const schema = z.unknown().transform(() => ({ valor: 7 }));
		const app = new Hono();
		app.post("/", cuerpoTolerante(schema), (c) => c.json(c.req.valid("json")));

		const casos: Array<Record<string, string>> = [{ "content-type": "application/json" }, {}];
		for (const headers of casos) {
			const res = await app.request("/", { method: "POST", headers, body: "{" });
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ valor: 7 });
		}
	});

	it("el veto anterior gana al parseo del cuerpo", async () => {
		let schemaEjecutado = false;
		const schema = z.unknown().transform(() => {
			schemaEjecutado = true;
			return {};
		});
		const app = new Hono();
		app.use("*", async (c) => c.json({ error: "forbidden_not_tpv" }, 403));
		app.post("/", cuerpoTolerante(schema), (c) => c.json({ ok: true }));

		const res = await app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{",
		});
		expect(res.status).toBe(403);
		expect(schemaEjecutado).toBe(false);
	});
});
