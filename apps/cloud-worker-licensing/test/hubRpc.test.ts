import { env as entorno } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { TenantHub } from "../src/durableObjects/tenantHub";
import type { Env } from "../src/env";
import { HubError, applyViaHub } from "../src/lib/hub";
import { enElHub } from "./helpers/hub";
import type { ApplyParams, ResultadoAplicacion } from "../src/durableObjects/tenantHub.rpc";

const env = entorno as unknown as Env;
const parametros: ApplyParams = {
	tenantId: "rpc-aplicar", deviceId: "handy", opId: "op", commandName: "prueba",
	command: { type: "tenantDb.exec", payload: { sql: "SELECT 1", args: [] } },
};
const stub = (nombre: string) => env.TenantHub.get(env.TenantHub.idFromName(nombre));

describe("TenantHub RPC", () => {
	it.each(["/internal/apply", "/internal/revoke", "/internal/pair-request"])("retira la antigua puerta HTTP %s", async (path) => {
		const respuesta = await stub("rpc-http").fetch(`https://do${path}`, { method: "POST" });
		expect(respuesta.status).toBe(404);
	});

	it("limita el prototipo RPC a las operaciones y callbacks previstos", () => {
		expect(Object.getOwnPropertyNames(TenantHub.prototype).sort()).toEqual([
			"constructor", "aplicar", "revocarDispositivo", "avisarEmparejamiento", "avisarReservasWeb", "fetch", "alarm",
			"webSocketMessage", "webSocketClose", "webSocketError",
			// La base del negocio vive en el DO.
			"consultar", "aprovisionar", "estaAprovisionado", "borrarTodo",
		].sort());
	});

	it("revoca y avisa aunque no haya conexiones", async () => {
		await expect(stub("rpc-sin-sockets").revocarDispositivo("equipo")).resolves.toBeUndefined();
		await expect(stub("rpc-sin-sockets").avisarEmparejamiento()).resolves.toBeUndefined();
		await expect(stub("rpc-sin-sockets").avisarReservasWeb()).resolves.toBeUndefined();
	});

	it("conserva los códigos de rechazo de negocio al cruzar RPC", async () => {
		const respuesta: ResultadoAplicacion = await stub("rpc-aplicar").aplicar(parametros);
		expect(respuesta).toEqual({ ok: false, error: "main_offline", status: 400 });
		await expect(applyViaHub(env, parametros)).rejects.toMatchObject({ code: "main_offline", status: 400 });
	});

	it("transporta resultados y conflictos sin perder el sobre idempotente", async () => {
		await enElHub("rpc-datos", (motor) => {
			motor.applyInternalCommandIdempotent = async (params: any) => {
				expect(params.cloudPayloadJson).toBe('{"dato":"á"}');
				expect(params.requestPayloadJson).toBe(params.cloudPayloadJson);
				if (params.opId === "conflicto") throw new HubError("idempotency_payload_mismatch", 409);
				return { result: { id: 23, valores: ["á", null] }, seq: 1 };
			};
		});
		const params = { ...parametros, tenantId: "rpc-datos", cloudPayload: { dato: "á" } };
		expect(await applyViaHub(env, params)).toEqual({ id: 23, valores: ["á", null] });
		await expect(applyViaHub(env, { ...params, opId: "conflicto" })).rejects.toMatchObject({ code: "idempotency_payload_mismatch", status: 409 });
	});
});
