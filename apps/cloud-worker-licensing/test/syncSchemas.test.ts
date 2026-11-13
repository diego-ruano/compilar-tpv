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
	verificarClavesSchema,
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

	it("descarta peticiones de claves inválidas y recorta antes de filtrar", () => {
		const primerasSesentaInvalidas = Array.from({ length: 60 }, () => ({
			nombre: "_Sync_Outbox",
			claves: ["Op_Id"],
		}));
		const parsed = verificarClavesSchema.parse({
			tablas: [
				...primerasSesentaInvalidas,
				{ nombre: "Zonas", claves: ["ID_Zona"] },
			],
		});
		expect(parsed.tablas).toEqual([]);

		expect(
			verificarClavesSchema.parse({
				tablas: [
					{ nombre: "Zonas", claves: ["ID_Zona"] },
					{ nombre: "Zonas; DROP TABLE Pagos", claves: ["ID_Zona"] },
					{ nombre: "Zonas", claves: [] },
				],
			}).tablas,
		).toEqual([{ nombre: "Zonas", claves: ["ID_Zona"] }]);
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
