// test/internalRevoke.test.ts
//
// FABLE-F: `/internal/revoke` del TenantHub cierra los sockets de un dispositivo.
// El DO no es direccionable desde Internet, pero eso es una suposición sobre el
// despliegue, no un control: la puerta la guarda el HMAC del worker. Estos tests
// son la red que impide que alguien vuelva a dejarla abierta.

import { env as workerEnv } from "cloudflare:test";
import { describe, it, expect } from "vitest";

import type { Env } from "../src/env";
import { signInternalWorkerRequest } from "../src/lib/internalAuth";

// `cloudflare:test` tipa `env` con el Env que genera wrangler (sólo las vars del
// `wrangler.json`). El Env real del worker —secretos incluidos— es `src/env.ts`,
// que es la fuente única en este repo.
const env = workerEnv as unknown as Env;

const PATH = "/internal/revoke";
const URL_DO = `https://do${PATH}`;

function hub(tenantId = "tenant-de-prueba") {
	return env.TenantHub.get(env.TenantHub.idFromName(tenantId));
}

/** Golpea el endpoint con las cabeceras que se le pasen (sin firmar nada). */
function post(body: string, headers: Record<string, string> = {}) {
	return hub().fetch(URL_DO, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body,
	});
}

describe("TenantHub /internal/revoke", () => {
	it("rechaza una petición sin firma", async () => {
		const res = await post(JSON.stringify({ deviceId: "d-1" }));

		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({
			ok: false,
			error: "missing_internal_auth",
		});
	});

	it("rechaza una firma hecha con otro secreto", async () => {
		const body = JSON.stringify({ deviceId: "d-1" });
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

	it("rechaza un cuerpo manipulado después de firmar", async () => {
		// La firma cubre el cuerpo: cambiar el deviceId invalida el HMAC. Sin esto,
		// quien alcanzara el DO podría reutilizar una firma legítima para echar a
		// OTRO dispositivo (p. ej. la Main, congelando todas las Handy).
		const firmado = JSON.stringify({ deviceId: "d-1" });
		const headers = await signInternalWorkerRequest(
			env.LICENSE_JWT_SECRET,
			"POST",
			PATH,
			firmado,
		);

		const res = await post(JSON.stringify({ deviceId: "d-victima" }), headers);

		expect(res.status).toBe(401);
		expect(await res.json()).toMatchObject({ error: "bad_internal_signature" });
	});

	it("acepta la petición firmada por el worker", async () => {
		const body = JSON.stringify({ deviceId: "d-1" });
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
