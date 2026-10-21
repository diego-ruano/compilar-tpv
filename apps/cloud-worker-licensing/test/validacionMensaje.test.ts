// test/validacionMensaje.test.ts
//
// VALID-02: cuando un schema rechaza la entrada, la respuesta lleva como `message` el texto de la
// regla que la Main da igual («Cada mesa necesita un nombre»), y la Handy lo enseña. Antes salía
// sólo `validation_error` y la Handy pintaba «Datos no válidos (validation_error)». Los mensajes que
// zod pone por defecto (en inglés, y sólo ante un cuerpo mal formado) no se enseñan.

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import * as z from "zod";

import { consulta, cuerpo, cuerpoTolerante } from "../src/lib/validacion";
import { saveLayoutSchema } from "../src/domains/mesas/mesas.schemas";
import { zDia } from "../src/lib/fechas";

const schema = z.object({
	nombre: z.string().min(1, "nombre required"),
	personas: z.number(),
	turno: z.string().refine((t) => t === "CENA", "Sólo hay turno de cena"),
});

async function enviar(app: Hono, cuerpoJson: unknown, ruta = "/") {
	const r = await app.request(ruta, {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cuerpoJson),
	});
	return { status: r.status, cuerpo: (await r.json()) as any };
}

describe("el motivo de un rechazo llega a quien está delante", () => {
	const app = new Hono()
		.post("/", cuerpo(schema), (c) => c.json(c.req.valid("json")))
		.post("/tolerante", cuerpoTolerante(schema), (c) => c.json(c.req.valid("json")))
		.post("/plano", cuerpo(saveLayoutSchema), (c) => c.json({ ok: true }));

	it("el texto de un refine o de un .min con su frase", async () => {
		const refine = await enviar(app, { nombre: "Ana", personas: 2, turno: "COMIDA" });
		expect(refine.status).toBe(400);
		expect(refine.cuerpo).toMatchObject({ error: "validation_error", code: "validation", message: "Sólo hay turno de cena" });

		const min = await enviar(app, { nombre: "", personas: 2, turno: "CENA" });
		expect(min.cuerpo.message).toBe("nombre required");

		const tolerante = await enviar(app, { nombre: "Ana", personas: 2, turno: "COMIDA" }, "/tolerante");
		expect(tolerante.cuerpo.message).toBe("Sólo hay turno de cena");
	});

	it("el de una regla del plano, con el mismo texto que la Main", async () => {
		const r = await enviar(app, { salons: [{ name: "Salón", room: { points: [] }, tables: [{ name: " " }] }] }, "/plano");
		expect(r.cuerpo.message).toBe("Cada mesa necesita un nombre");
	});

	it("un mensaje de zod por defecto no se enseña, y los issues siguen diciendo lo que pasó", async () => {
		const r = await enviar(app, { nombre: "Ana", turno: "CENA" });
		expect(r.status).toBe(400);
		expect(r.cuerpo).not.toHaveProperty("message");
		expect(r.cuerpo.issues[0].message).toMatch(/expected number/);
	});

	it("si el primer fallo es de zod, tampoco el de una regla que venga detrás", async () => {
		const r = await enviar(app, { nombre: "Ana", turno: "COMIDA" });
		expect(r.cuerpo).not.toHaveProperty("message");
	});

	it("también en la cadena de consulta", async () => {
		const q = new Hono().get("/", consulta(z.object({ dia: zDia("dia inválido (YYYY-MM-DD)") })), (c) => c.json({ ok: true }));
		const r = await q.request("/?dia=2026-02-31");
		expect(r.status).toBe(400);
		expect(((await r.json()) as any).message).toBe("dia inválido (YYYY-MM-DD)");
	});
});
