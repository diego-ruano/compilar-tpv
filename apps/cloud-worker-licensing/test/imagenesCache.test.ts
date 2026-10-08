import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { claveCacheImagen, imagesRoutes } from "../src/domains/images/images.routes";

describe("caché pública de imágenes", () => {
	it("queries distintas usan una sola lectura de R2 y la misma clave para borrar", async () => {
		const get = vi.fn(async () => ({ body: new Response("imagen").body, httpEtag: '"etag"' }));
		const env = { IMAGES: { get } } as unknown as Env;
		const app = new Hono<{ Bindings: Env }>().route("/v1/images", imagesRoutes);
		const url = `https://imagenes.test/v1/images/${crypto.randomUUID()}/images/productos/prueba.jpg`;
		for (const query of ["?v=1", "?otro=2", ""]) {
			const ctx = createExecutionContext();
			const respuesta = await app.fetch(new Request(url + query), env, ctx);
			expect(respuesta.status).toBe(200);
			expect(new Uint8Array(await respuesta.arrayBuffer())).toEqual(new TextEncoder().encode("imagen"));
			await waitOnExecutionContext(ctx);
		}
		expect(get).toHaveBeenCalledTimes(1);
		expect(await caches.default.delete(new Request(url))).toBe(true);
		expect(await caches.default.match(claveCacheImagen(new Request(url + "?v=3")))).toBeUndefined();
	});

	it("conserva tenant y cabeceras condicionales al normalizar", () => {
		const request = new Request("https://imagenes.test/v1/images/tenant-a/images/logo/a.png?v=23", {
			headers: { "if-none-match": '"etag"' },
		});
		const key = claveCacheImagen(request);
		expect(key.url).toBe("https://imagenes.test/v1/images/tenant-a/images/logo/a.png");
		expect(key.headers.get("if-none-match")).toBe('"etag"');
		expect(claveCacheImagen(new Request(key.url.replace("tenant-a", "tenant-b"))).url).not.toBe(key.url);
	});

	it("un 404 no impide servir una imagen que llega después", async () => {
		const get = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ body: new Response("llegó").body });
		const env = { IMAGES: { get } } as unknown as Env;
		const app = new Hono<{ Bindings: Env }>().route("/v1/images", imagesRoutes);
		const url = `https://imagenes.test/v1/images/${crypto.randomUUID()}/images/logo/prueba.png`;
		const ctx = createExecutionContext();
		expect((await app.fetch(new Request(url + "?v=1"), env, ctx)).status).toBe(404);
		const respuesta = await app.fetch(new Request(url + "?v=2"), env, ctx);
		expect(respuesta.status).toBe(200);
		await waitOnExecutionContext(ctx);
		expect(get).toHaveBeenCalledTimes(2);
	});
});
