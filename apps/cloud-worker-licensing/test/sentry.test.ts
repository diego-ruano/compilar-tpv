import { describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/cloudflare";
import { HTTPException } from "hono/http-exception";
import { HubError } from "../src/lib/errorHttp";
import { sentryOptions } from "../src/observability/sentry";
import { seleccionarCuerpo } from "../src/observability/requestContext";
import { capturarError, esRechazoEsperado } from "../src/observability/errors";
import type { Env } from "../src/env";
import { Hono } from "hono";
import * as z from "zod";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { cuerpo } from "../src/lib/validacion";

it("el SDK real envía un único fallo de Hono con el cuerpo seleccionado y descarta el JSON roto", async () => {
	const enviados: unknown[] = [];
	const app = new Hono();
	app.post("/v1/inventario/productos", cuerpo(z.object({ nombre: z.string(), precio_venta: z.number() })), () => { throw new Error("Fallo de SQL de prueba"); });
	app.onError((error) => { capturarError(error, "POST /v1/inventario/productos"); return new Response("fallo", { status: 500 }); });
	const handler = Sentry.withSentry<Env>(() => ({
		...sentryOptions({ SENTRY_DSN: "https://public@worker.example/123", SENTRY_RELEASE: "tpv-api@0.1.0" } as Env),
		transport: () => ({ send: async (envelope: unknown) => { enviados.push(structuredClone(envelope)); return { statusCode: 200 }; }, flush: async () => true }),
	}), { fetch: (request: Request, _env: Env, _ctx: ExecutionContext) => app.fetch(request) });
	for (const body of [JSON.stringify({ nombre: "Ana López", precio_venta: 120, notas: "diabetes" }), "{"]) {
		const ctx = createExecutionContext();
		await handler.fetch!(new Request("https://worker.example/v1/inventario/productos?token=secret", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer secret" }, body }), {} as Env, ctx);
		await waitOnExecutionContext(ctx);
	}
	const events = (enviados as any[]).flatMap(envelope => envelope[1].filter((item: any) => item[0].type === "event").map((item: any) => item[1]));
	expect(events).toHaveLength(1);
	expect(events[0].contexts.request_input).toMatchObject({ precio_venta: 120 });
	expect(events[0].release).toBe("tpv-api@0.1.0");
	const salida = JSON.stringify(events);
	for (const dato of ["Ana López", "diabetes", "Bearer secret", "token=secret"]) expect(salida).not.toContain(dato);
});

describe("Sentry: diagnóstico con una lista positiva de datos", () => {
	it("conserva importes y stock, excluye datos libres y campos nuevos", () => {
		const datos = { precio_venta: 120, stock_suelto: 3, iva_percent: 10, nombre: "Ana López", notas: "diabetes", pin: 1234, nuevo: "secreto" };
		expect(seleccionarCuerpo("POST /v1/inventario/productos", datos)).toEqual({ precio_venta: 120, stock_suelto: 3, iva_percent: 10 });
		expect(seleccionarCuerpo("POST /v1/login", datos)).toEqual({});
		expect(seleccionarCuerpo("POST /v1/inventario/productos", { precio_venta: "nombre secreto", stock_suelto: Infinity })).toEqual({});
	});
	it("elimina cuerpo, credenciales, consultas, usuario y consola antes del transporte", () => {
		const event = sentryOptions({} as Env).beforeSend({
			message: "La base central no responde", user: { name: "Ana López" }, extra: { notas: "diabetes" },
			request: { url: "https://secret:password@worker.example/ws?ticket=opaque-secret", data: { pin: "1234" }, headers: { Authorization: "Bearer secret" }, cookies: "session=secret", query_string: "ticket=opaque-secret" },
			breadcrumbs: [{ category: "console", message: "Ana López" }],
		});
		expect(event).toEqual({ message: "La base central no responde", request: { url: "https://worker.example/ws" }, breadcrumbs: [] });
	});
});

describe("Sentry: rechazos esperados y fallos técnicos", () => {
	it("descarta validación y Main desconectada, conserva infraestructura aunque incluya status", () => {
		for (const error of [new HTTPException(400), new HTTPException(401), new HubError("main_offline", 503), new HubError("idempotency_conflict", 409)]) {
			expect(esRechazoEsperado(error)).toBe(true);
			expect(sentryOptions({} as Env).beforeSend({ message: "rechazo" }, { originalException: error })).toBeNull();
		}
		for (const error of [new Error("SQL roto"), new HubError("tenant_db_unavailable", 503), Object.assign(new Error("fallo desconocido"), { status: 400 })]) expect(esRechazoEsperado(error)).toBe(false);
	});
	it("notifica el error capturado sin cambiar su identidad ni propagar un fallo del SDK", () => {
		const capture = vi.spyOn(Sentry, "captureException").mockReturnValue("event-id");
		const error = new Error("envío fallido");
		capturarError(error, "email.send");
		expect(capture).toHaveBeenCalledWith(error, { tags: { operation: "email.send" } });
		capturarError(new HTTPException(400), "validation");
		expect(capture).toHaveBeenCalledTimes(1);
		capture.mockImplementation(() => { throw new Error("transporte roto"); });
		expect(() => capturarError(error, "email.send")).not.toThrow();
		capture.mockRestore();
	});
});
