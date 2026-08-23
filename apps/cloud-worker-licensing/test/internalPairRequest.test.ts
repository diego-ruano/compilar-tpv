// test/internalPairRequest.test.ts
//
// `/internal/pair-request` es el aviso que sustituye al sondeo del panel de "Vincular Handy":
// cuando un Handy reclama un código, el worker se lo empuja a la Main por su WebSocket.
//
// Se guarda con el mismo HMAC que el resto de puertas internas del DO (FABLE-F). No es
// paranoia: quien pudiera dispararlo a voluntad tendría un despertador gratis del Durable
// Object —que factura por tiempo despierto— y una forma de hacer parpadear la pantalla de
// aprobación de cualquier local.

import { env as workerEnv } from "cloudflare:test";
import { describe, it, expect } from "vitest";

import type { Env } from "../src/env";
import { signInternalWorkerRequest } from "../src/lib/internalAuth";

const env = workerEnv as unknown as Env;

const PATH = "/internal/pair-request";
const URL_DO = `https://do${PATH}`;

function hub(tenantId = "tenant-de-prueba") {
	return env.TenantHub.get(env.TenantHub.idFromName(tenantId));
}

function post(body: string, headers: Record<string, string> = {}) {
	return hub().fetch(URL_DO, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body,
	});
}

describe("TenantHub /internal/pair-request", () => {
	it("rechaza una petición sin firma", async () => {
		const res = await post(JSON.stringify({ tenantId: "t-1" }));

		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({
			ok: false,
			error: "missing_internal_auth",
		});
	});

	it("rechaza una firma hecha con otro secreto", async () => {
		const body = JSON.stringify({ tenantId: "t-1" });
		const headers = await signInternalWorkerRequest(
			"otro-secreto",
			"POST",
			PATH,
			body,
		);

		const res = await post(body, headers);

		expect(res.status).toBe(401);
		expect(await res.json()).toMatchObject({ error: "bad_internal_signature" });
	});

	it("acepta la petición firmada por el worker aunque no haya nadie conectado", async () => {
		// Sin Main conectada el aviso no llega a ningún sitio, y eso NO es un error: el claim
		// ya está guardado y el panel lo verá en su recarga de respaldo. Si esto devolviera un
		// fallo, `pairClaim` acabaría registrando ruido en cada emparejamiento offline.
		const body = JSON.stringify({ tenantId: "t-1" });
		const headers = await signInternalWorkerRequest(
			env.LICENSE_JWT_SECRET,
			"POST",
			PATH,
			body,
		);

		const res = await post(body, headers);

		expect(res.status).toBe(200);
		expect(await res.text()).toBe("OK");
	});
});
