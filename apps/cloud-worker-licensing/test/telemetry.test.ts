import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "hono";
import type { Env } from "../src/env";

const { auth, ingest } = vi.hoisted(() => ({ auth: vi.fn(), ingest: vi.fn() }));
vi.mock("../src/middleware/tenant", () => ({
	tenantAuth: async (c: Context, next: () => Promise<void>) => {
		auth();
		c.set("tenantId", "tenant-autenticado");
		c.set("deviceId", "dispositivo-autenticado");
		await next();
	},
}));
vi.mock("../src/observability/axiom", () => ({ ingestToAxiom: ingest }));

import { telemetryRoutes } from "../src/domains/telemetry/telemetry.routes";

function post(body: string, headers: Record<string, string> = {}) {
	return telemetryRoutes.request("http://localhost/", {
		method: "POST", headers: { "Content-Type": "application/json", ...headers }, body,
	}, {} as Env);
}

describe("ingesta de lotes de telemetría", () => {
	beforeEach(() => { vi.clearAllMocks(); ingest.mockResolvedValue(true); });

	it("rechaza el exceso de bytes sin Content-Length antes de autenticar", async () => {
		const response = await post(JSON.stringify({ events: [], relleno: "x".repeat(2 * 1024 * 1024) }));
		expect(response.status).toBe(413);
		expect(auth).not.toHaveBeenCalled();
		expect(ingest).not.toHaveBeenCalled();
	});

	// AUD-32: todo el lote pasa por el filtro de datos personales antes de responder.
	it("el techo del cuerpo es 1 MiB: el doble del mayor lote que manda un dispositivo", async () => {
		const evento = (n: number) => ({ message: "evento", fields: { detalle: "x".repeat(n) } });
		// 500 eventos y 512 KiB, como el mayor lote del dispositivo (`spool.rs`).
		const lote = JSON.stringify({ events: Array.from({ length: 500 }, () => evento(1010)) });
		expect(lote.length).toBeGreaterThan(512 * 1024);
		expect((await post(lote)).status).toBe(200);
		expect(ingest.mock.calls[0][2]).toHaveLength(500);

		ingest.mockClear();
		auth.mockClear();
		const excesivo = JSON.stringify({ events: Array.from({ length: 10 }, () => evento(105_000)) });
		expect(excesivo.length).toBeGreaterThan(1024 * 1024);
		expect(excesivo.length).toBeLessThan(2 * 1024 * 1024);
		expect((await post(excesivo)).status).toBe(413);
		expect(auth).not.toHaveBeenCalled();
		expect(ingest).not.toHaveBeenCalled();
	});

	it("los campos de un evento tienen su tope: 128 KiB entre todos y 256 caracteres de nombre", async () => {
		const conCampos = (fields: unknown) => post(JSON.stringify({ events: [{ message: "evento", fields }] }));

		// Lo que cabe: el propio dispositivo no manda un evento de más de 128 KiB.
		expect((await conCampos({ detalle: "x".repeat(100_000), ["n".repeat(256)]: 1 })).status).toBe(200);
		expect(ingest).toHaveBeenCalledTimes(1);
		ingest.mockClear();

		expect((await conCampos({ detalle: "x".repeat(128 * 1024) })).status).toBe(400);
		// Repartido en muchas cadenas también cuenta: el tope es del conjunto, no de cada una.
		expect((await conCampos(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`c${i}`, "x".repeat(4000)])))).status).toBe(400);
		expect((await conCampos({ lista: [{ dentro: ["x".repeat(128 * 1024)] }] })).status).toBe(400);
		expect((await conCampos({ ["n".repeat(257)]: 1 })).status).toBe(400);
		// Ni anidados: lo que no cabe o no se deja medir se rechaza como un dato que no vale, no con un 500.
		expect((await post(`{"events":[{"fields":{"a":${"[".repeat(100_000)}${"]".repeat(100_000)}}}]}`)).status).toBe(400);
		expect(ingest).not.toHaveBeenCalled();
	});

	it("acepta 500 eventos y fija las identidades desde la autenticación", async () => {
		const response = await post(JSON.stringify({ events: Array.from({ length: 500 }, () => ({
			message: "evento", tenant_id: "inventado", device_id: "inventado",
		})) }));
		expect(response.status).toBe(200);
		expect(ingest.mock.calls[0][2]).toHaveLength(500);
		expect(ingest.mock.calls[0][2][0]).toMatchObject({ tenant_id: "tenant-autenticado", device_id: "dispositivo-autenticado" });
	});

	it("rechaza 501 eventos o un mensaje excesivo", async () => {
		expect((await post(JSON.stringify({ events: Array.from({ length: 501 }, () => ({})) }))).status).toBe(400);
		expect((await post(JSON.stringify({ events: [{ message: "x".repeat(4001) }] }))).status).toBe(400);
		expect(ingest).not.toHaveBeenCalled();
	});

	it("un fallo de Axiom devuelve 502 para conservar el lote en el dispositivo", async () => {
		ingest.mockResolvedValue(false);
		expect((await post(JSON.stringify({ events: [{ message: "conservar" }] }))).status).toBe(502);
	});
});
