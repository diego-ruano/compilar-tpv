// test/claveDeIdempotencia.test.ts
//
// AUD-32 — la `X-Idempotency-Key` de una escritura tiene una forma: de 16 a 64 letras, cifras,
// guiones o guiones bajos (la Handy manda un UUIDv7).
//
// Antes sólo se recortaba. La clave es el `Op_Id` de la operación: se guarda en la base del negocio,
// viaja a la Main y sale en los eventos de `tpv-sync`, que pasan por el filtro de datos personales
// dentro del Durable Object; y una cabecera puede ocupar 128 KB. Una que no tiene su forma se
// rechaza en la ruta, con su identificador, sin llamar al Durable Object.

import type { Context } from "hono";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { cuerpoDeErrorConStatus } from "../src/lib/errorHttp";
import { MENSAJES, SIN_MENSAJE_PROPIO } from "../src/lib/errorCodes";
import { completarErrores } from "../src/middleware/completarErrores";

vi.mock(import("../src/middleware/tenant"), async (importOriginal) => ({
	...(await importOriginal()),
	tenantAuth: async (c: Context, next: () => Promise<void>) => {
		c.set("tenantId", "negocio-ficticio");
		c.set("deviceId", "handy-ficticia");
		await next();
	},
}));

import { clientesRoutes } from "../src/domains/clientes/clientes.routes";

const UUID_V7 = "0190f3c2-7d1e-7c4a-9b2e-5a6f7e8d9c0b";

const aplicar = vi.fn();
const hub = { idFromName: vi.fn(() => "id-del-hub"), get: vi.fn(() => ({ aplicar })) };

// Como `src/index.ts`: un `HubError` sale como JSON con su status, y `completarErrores` le pone el código.
const app = new Hono<{ Bindings: Env }>();
app.use("*", completarErrores);
app.route("/v1/clientes", clientesRoutes);
app.onError((err, c) => c.json(cuerpoDeErrorConStatus(err), ((err as any)?.status ?? 500) as any));

async function crearCliente(clave: string | undefined) {
	const respuesta = await app.request(
		"http://localhost/v1/clientes",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Client-Now": "2026-11-10 13:00:00",
				...(clave === undefined ? {} : { "X-Idempotency-Key": clave }),
			},
			body: JSON.stringify({ id_cliente: null, nombre: "Cliente ficticio" }),
		},
		{ TenantHub: hub } as unknown as Env,
	);
	return { status: respuesta.status, cuerpo: (await respuesta.json()) as Record<string, unknown> };
}

describe("AUD-32 · la forma de la X-Idempotency-Key", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		aplicar.mockResolvedValue({ ok: true, data: "cliente-nuevo" });
	});

	it.each([
		["un UUIDv7, que es lo que manda la Handy", UUID_V7],
		["16 caracteres, el mínimo", "a".repeat(16)],
		["64 caracteres, el máximo", "A1_-".repeat(16)],
	])("%s llega al Durable Object tal cual", async (_caso, clave) => {
		const r = await crearCliente(clave);
		expect(r.status, JSON.stringify(r.cuerpo)).toBe(200);
		expect(aplicar).toHaveBeenCalledTimes(1);
		expect(aplicar.mock.calls[0][0]).toMatchObject({ opId: clave, tenantId: "negocio-ficticio", deviceId: "handy-ficticia" });
	});

	it.each([
		["15 caracteres", "a".repeat(15)],
		["65 caracteres", "a".repeat(65)],
		["128 KB, lo que cabe en una cabecera", "a".repeat(128 * 1024)],
		["un espacio en medio", "0190f3c2 7d1e-7c4a-9b2e-5a6f7e8d9c0b"],
		["dos puntos", "reparacion:0190f3c2-7d1e-7c4a-9b2e"],
		["puntos", "0190f3c2.7d1e.7c4a.9b2e.5a6f7e8d9c0b"],
		["un correo", "ana.garcia@example.com"],
	])("%s se rechaza con invalid_op_id sin llegar al Durable Object", async (_caso, clave) => {
		const r = await crearCliente(clave);
		expect(r.status).toBe(400);
		expect(r.cuerpo).toMatchObject({ ok: false, error: "invalid_op_id", code: "validation" });
		// Ni la clave ni nada de ella vuelve en la respuesta.
		expect(JSON.stringify(r.cuerpo).length).toBeLessThan(200);
		expect(hub.idFromName).not.toHaveBeenCalled();
		expect(hub.get).not.toHaveBeenCalled();
		expect(aplicar).not.toHaveBeenCalled();
	});

	it("sin clave sigue siendo missing_op_id", async () => {
		const r = await crearCliente(undefined);
		expect(r.status).toBe(400);
		expect(r.cuerpo).toMatchObject({ error: "missing_op_id", code: "validation" });
		expect(aplicar).not.toHaveBeenCalled();
	});

	it("el identificador está clasificado: es interno, sin frase propia", () => {
		expect(SIN_MENSAJE_PROPIO.has("invalid_op_id")).toBe(true);
		expect(MENSAJES).not.toHaveProperty("invalid_op_id");
	});
});
