// test/sinDetalleInterno.test.ts
//
// FABLE-B: una respuesta de error no cuenta cómo ha fallado el worker por dentro: la traza o el
// texto crudo de la base los leería cualquiera que provocara el fallo. El detalle se queda en el
// log y en Sentry; al cliente le basta el `code`.
//
// Las firmas de `serverError`, `unauthorized` y `forbidden` ya no aceptan detalles. Esto fija la
// otra mitad: lo que sale por ellas, también después de pasar por `completarCuerpoDeError`.

import { describe, expect, it } from "vitest";

import { completarCuerpoDeError } from "../src/lib/errorCodes";
import { forbidden, serverError, unauthorized } from "../src/server/utils/response";

const peticion = () => new Request("https://tpv-api.test/v1/lo-que-sea");

async function cuerpo(res: Response): Promise<Record<string, unknown>> {
	return completarCuerpoDeError((await res.json()) as Record<string, unknown>, res.status);
}

describe("FABLE-B: los errores no llevan su detalle interno", () => {
	it("un 500 sólo dice qué clase de fallo es", async () => {
		const res = serverError(peticion(), "internal_error");

		expect(res.status).toBe(500);
		const body = await cuerpo(res);
		expect(Object.keys(body).sort()).toEqual(["code", "error", "ok"]);
		expect(body).toMatchObject({ ok: false, error: "internal_error" });
	});

	it("un 401 y un 403 tampoco llevan detalles", async () => {
		for (const res of [
			unauthorized(peticion(), "invalid_ticket"),
			forbidden(peticion(), "license_revoked"),
		]) {
			const body = await cuerpo(res);
			expect(body).not.toHaveProperty("details");
			expect(body).not.toHaveProperty("stack");
		}
	});
});
