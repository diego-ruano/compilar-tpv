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
			"constructor", "aplicar", "revocarDispositivo", "releerMain", "avisarEmparejamiento", "avisarReservasWeb", "fetch",
			"webSocketMessage", "webSocketClose", "webSocketError",
			// La base del negocio vive en el DO.
			"leerParaLaWeb", "aprovisionar", "estaAprovisionado", "borrarTodo",
			// Una ruta de negocio entera, ejecutada junto a la base (`lib/enElHub.ts`).
			"ejecutarRuta",
			// DO-03: la copia diaria (su alarma) y la administración de la base: estado, copia y vuelta a un instante.
			"alarm", "copiarAhora", "estadoDeLaBase", "prepararVuelta", "reiniciar", "trasVolver",
			// DO-PERDIDA: darle base a un objeto vacío de un negocio que ya nació.
			"crearBaseVacia", "restaurarDesdeCopia",
		].sort());
	});

	it("revoca y avisa aunque no haya conexiones", async () => {
		await expect(stub("rpc-sin-sockets").revocarDispositivo("equipo")).resolves.toBeUndefined();
		// Sin negocio no lee: con uno, leería la base central de verdad, y eso tiene sus pruebas con su doble.
		await expect(stub("rpc-sin-sockets").releerMain("")).resolves.toBeUndefined();
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
				// El cuerpo del dominio es lo que identifica la operación (`Request_Hash`).
				expect(params.requestPayloadJson).toBe('{"dato":"á"}');
				expect(params.cloudPayloadJson).toBeUndefined();
				if (params.opId === "conflicto") throw new HubError("idempotency_payload_mismatch", 409);
				return { result: { id: 23, valores: ["á", null] }, seq: 1 };
			};
		});
		const params = { ...parametros, tenantId: "rpc-datos", cloudPayload: { dato: "á" } };
		expect(await applyViaHub(env, params)).toEqual({ id: 23, valores: ["á", null] });
		await expect(applyViaHub(env, { ...params, opId: "conflicto" })).rejects.toMatchObject({ code: "idempotency_payload_mismatch", status: 409 });
	});
});
