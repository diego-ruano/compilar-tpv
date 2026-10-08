import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { cuerpo } from "../src/lib/validacion";
import { activarSchema, pedirCambioSchema } from "../src/domains/licensing/licensing.schemas";

const identidad = {
	activationKey: "TPV-12345-12345-12345-12345",
	deviceId: "equipo",
	devicePubKey: btoa(String.fromCharCode(...new Uint8Array(32).fill(1))),
};

describe("contrato de activación", () => {
	it.each([
		{ ...identidad, deviceId: undefined },
		{ ...identidad, deviceId: "   " },
		{ ...identidad, deviceId: 42 },
		{ ...identidad, devicePubKey: "una cadena" },
		{ ...identidad, devicePubKey: btoa("corta") },
		{ ...identidad, tenantInfo: [] },
		{ ...identidad, soloSumar: "true" },
		{ ...identidad, deviceChangeCode: "123" },
	])("rechaza un cuerpo inválido antes del handler", async (body) => {
		let ejecutado = false;
		const app = new Hono().post("/", cuerpo(activarSchema), (c) => {
			ejecutado = true;
			return c.json(c.req.valid("json"));
		});
		const respuesta = await app.request("/", {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
		});
		expect(respuesta.status).toBe(400);
		expect(ejecutado).toBe(false);
	});

	it("conserva la identidad del equipo y normaliza sus espacios", () => {
		expect(activarSchema.parse({ ...identidad, deviceId: " equipo " })).toEqual(identidad);
	});

	it("exige también la identidad para pedir un traslado", () => {
		expect(pedirCambioSchema.safeParse({ activationKey: identidad.activationKey }).success).toBe(false);
		expect(pedirCambioSchema.parse(identidad)).toEqual({ activationKey: identidad.activationKey, deviceId: "equipo" });
	});
});
