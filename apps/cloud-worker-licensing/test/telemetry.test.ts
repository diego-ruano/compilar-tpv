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
