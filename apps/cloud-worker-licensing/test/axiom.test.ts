import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { ingestToAxiom, reportarRechazoDeDispositivo } from "../src/observability/axiom";

const env = { AXIOM_TOKEN: "token-de-pruebas", AXIOM_DATASET_SYNC: "tpv-sync" } as Env;
const send = vi.fn<typeof fetch>();
const warn = vi.fn();

describe("la salida común a Axiom filtra antes de enviar", () => {
	beforeEach(() => {
		send.mockReset().mockResolvedValue(new Response("", { status: 200 }));
		warn.mockReset();
		vi.stubGlobal("fetch", send);
		vi.spyOn(console, "warn").mockImplementation(warn);
	});
	afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

	it("filtra logs del dispositivo y errores del servidor sin modificar los originales", async () => {
		const events = [
			{ service: "tpv-device", message: 'fallo {"password":"hunter2"}', fields: { access_token: "secreto" } },
			{ service: "tpv-sync", error: "ana@example.com tel=612345678 911222333",
				op_id: "01925678-1234-7123-8123-123456789012", last_ok_ms: "1727450000002",
				hash: "abcdef1234567890abcdef", device_id: "dispositivo-1", tenant_id: "negocio-1", latency_ms: 15,
				_time: "2026-10-08T10:00:00Z", fields: { lista: [{ refreshToken: "otro-secreto" }] } },
		];
		const original = structuredClone(events);
		expect(await ingestToAxiom(env, "logs", events)).toBe(true);
		expect(events).toEqual(original);
		const init = send.mock.calls[0][1];
		expect(init?.headers).toMatchObject({ Authorization: "Bearer token-de-pruebas" });
		const body = String(init?.body);
		for (const secret of ["hunter2", "secreto", "otro-secreto", "ana@example.com", "612345678", "911222333"]) {
			expect(body).not.toContain(secret);
		}
		expect(JSON.parse(body)[1]).toMatchObject({
			op_id: original[1].op_id, last_ok_ms: "1727450000002", hash: "abcdef1234567890abcdef",
			device_id: "dispositivo-1", tenant_id: "negocio-1", latency_ms: 15, _time: "2026-10-08T10:00:00Z",
		});
	});

	it("un reportero del worker también usa el filtro común", async () => {
		await reportarRechazoDeDispositivo(env, { motivo: "password=hunter2", ruta: "/v1/sync", metodo: "POST" });
		expect(String(send.mock.calls[0][1]?.body)).not.toContain("hunter2");
	});

	it("si el lote no puede copiarse o serializarse no sale ninguna petición", async () => {
		expect(await ingestToAxiom(env, "logs", [{ no_serializable: () => {} }])).toBe(false);
		expect(await ingestToAxiom(env, "logs", [{ no_serializable: 1n }])).toBe(false);
		expect(send).not.toHaveBeenCalled();
	});

	it("sin token o con un lote vacío conserva el no-op", async () => {
		expect(await ingestToAxiom({} as Env, "logs", [{ message: "evento" }])).toBe(true);
		expect(await ingestToAxiom(env, "logs", [])).toBe(true);
		expect(send).not.toHaveBeenCalled();
	});

	it("los fallos HTTP/red conservan el lote y redactan el aviso local", async () => {
		send.mockResolvedValueOnce(new Response("password=hunter2", { status: 502 }));
		expect(await ingestToAxiom(env, "logs", [{ message: "evento" }])).toBe(false);
		send.mockRejectedValueOnce(new Error("token=secreto"));
		expect(await ingestToAxiom(env, "logs", [{ message: "evento" }])).toBe(false);
		expect(warn).toHaveBeenCalledTimes(2);
		expect(JSON.stringify(warn.mock.calls)).not.toContain("hunter2");
		expect(JSON.stringify(warn.mock.calls)).not.toContain("token=secreto");
	});
});
