// test/imagenesPorElWorker.test.ts
//
// INFRA-03 · La Handy pinta las imágenes por el GET público del worker, `/v1/images/{tenant}/{ruta}`,
// y no por el `r2.dev` del bucket. La URL la compone la app (`handy_url_imagenes` en Rust y
// `imageUrl.ts`): `{CLOUD_API_BASE}/v1/images/{tenant}/images/{carpeta}/{uuid}.{ext}`. Aquí entra
// por el worker entero (`SELF`), con el R2 local de verdad, lo mismo que pediría el `<img>`:
//   · el 200 lleva los bytes, el tipo según la extensión (que el PUT ya obliga a casar con los
//     bytes), un año de caché inmutable y `nosniff`;
//   · lo que no es una imagen (ruta mala, aún no subida, frenado) sale con `no-store`;
//   · el negocio del camino es la carpeta del bucket: otro negocio no llega a lo que no es suyo;
//   · el filtro por IP sólo cuenta lo que llega a R2, y está declarado en `wrangler.json`.

import { SELF, createExecutionContext, env as entorno, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { app } from "../src/app";
import configuracionDelWorker from "../wrangler.json";

const env = entorno as any;

/** La cabecera de un PNG de 1×1 (firma e IHDR): es lo que el PUT deja subir. */
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);

/** Un negocio nuevo en cada prueba: la Cache API del worker de pruebas dura toda la suite. */
const negocio = () => crypto.randomUUID();
const ruta = (carpeta: string, ext: string) => `images/${carpeta}/${crypto.randomUUID()}.${ext}`;

async function subir(tenant: string, rel: string, bytes: Uint8Array) {
	await env.IMAGES.put(`${tenant}/${rel}`, bytes);
}

const pedir = (camino: string) => SELF.fetch(`https://tpv.test${camino}`);

describe("INFRA-03 · el GET público de imágenes", () => {
	it("da los bytes con su tipo, un año de caché inmutable y nosniff", async () => {
		const tenant = negocio();
		const png = ruta("productos", "png");
		const jpg = ruta("logo", "jpg");
		await subir(tenant, png, PNG);
		await subir(tenant, jpg, JPEG);

		const r = await pedir(`/v1/images/${tenant}/${png}`);
		expect(r.status).toBe(200);
		expect(new Uint8Array(await r.arrayBuffer())).toEqual(PNG);
		expect(r.headers.get("Content-Type")).toBe("image/png");
		expect(r.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
		expect(r.headers.get("X-Content-Type-Options")).toBe("nosniff");

		const j = await pedir(`/v1/images/${tenant}/${jpg}`);
		expect(j.status).toBe(200);
		expect(new Uint8Array(await j.arrayBuffer())).toEqual(JPEG);
		expect(j.headers.get("Content-Type")).toBe("image/jpeg");
	});

	it("una imagen que aún no está es un 404 que no se guarda en ninguna caché", async () => {
		const tenant = negocio();
		const rel = ruta("productos", "jpg");

		const antes = await pedir(`/v1/images/${tenant}/${rel}`);
		expect(antes.status).toBe(404);
		expect(antes.headers.get("Cache-Control")).toBe("no-store");
		await antes.arrayBuffer();

		// Llega la subida: el mismo URL ya la da.
		await subir(tenant, rel, JPEG);
		const despues = await pedir(`/v1/images/${tenant}/${rel}`);
		expect(despues.status).toBe(200);
		expect(new Uint8Array(await despues.arrayBuffer())).toEqual(JPEG);
	});

	it("una ruta que no es de la app es un 400 sin caché y no llega a R2", async () => {
		const tenant = negocio();
		for (const mala of [
			"images/productos/tarta.png",
			"images/proveedores/Juan-Perez.jpg",
			"images/otra/0190f3a1-7b2c-4d4e-8f00-123456789abc.png",
			"IMAGES/productos/0190f3a1-7b2c-4d4e-8f00-123456789abc.png",
			"images/productos/0190f3a1-7b2c-4d4e-8f00-123456789abc.gif",
		]) {
			await env.IMAGES.put(`${tenant}/${mala}`, PNG);
			const r = await pedir(`/v1/images/${tenant}/${mala}`);
			expect(r.status, mala).toBe(400);
			expect(r.headers.get("Cache-Control"), mala).toBe("no-store");
			await r.arrayBuffer();
		}
	});

	it("el negocio del camino es la carpeta del bucket: otro negocio no ve lo que no es suyo", async () => {
		const dueno = negocio();
		const rel = ruta("productos", "png");
		await subir(dueno, rel, PNG);

		for (const otro of [negocio(), dueno.slice(0, -1), `${dueno}x`, dueno.toUpperCase()]) {
			const r = await pedir(`/v1/images/${otro}/${rel}`);
			expect(r.status, otro).toBe(404);
			await r.arrayBuffer();
		}
		const suyo = await pedir(`/v1/images/${dueno}/${rel}`);
		expect(suyo.status).toBe(200);
		await suyo.arrayBuffer();
	});
});

describe("INFRA-03 · el filtro por IP del GET de imágenes", () => {
	it("está declarado en wrangler.json, holgado y por minuto", () => {
		const limitadores = (configuracionDelWorker as any).ratelimits ?? [];
		const imagenes = limitadores.find((l: any) => l.name === "LIMITADOR_IMAGENES");
		expect(imagenes, "sin este binding el GET de imágenes no tiene techo por red").toBeTruthy();
		// Una Handy que estrena la carta pide cientos de imágenes de golpe, y las de un bar salen por
		// la misma IP: un techo de pocas decenas la dejaría a medias.
		expect(imagenes.simple.limit).toBeGreaterThanOrEqual(1000);
		// El binding sólo admite 10 o 60.
		expect(imagenes.simple.period).toBe(60);
	});

	it("lleno, contesta 429 sin caché ni lectura de R2, y la clave es la red de quien pide", async () => {
		const tenant = negocio();
		const rel = ruta("productos", "png");
		await subir(tenant, rel, PNG);
		const claves: string[] = [];
		const get = vi.fn(async (k: string) => env.IMAGES.get(k));
		const lleno = {
			limit: async ({ key }: { key: string }) => {
				claves.push(key);
				return { success: false };
			},
		};

		const ctx = createExecutionContext();
		const r = await app.fetch(
			new Request(`https://tpv.test/v1/images/${tenant}/${rel}`, { headers: { "CF-Connecting-IP": "2001:db8:0:1::5" } }),
			{ ...env, IMAGES: { get }, LIMITADOR_IMAGENES: lleno },
			ctx,
		);
		await waitOnExecutionContext(ctx);
		expect(r.status).toBe(429);
		expect(r.headers.get("Cache-Control")).toBe("no-store");
		expect(r.headers.get("Retry-After")).toBe("60");
		expect(((await r.json()) as any).error).toBe("too_many_attempts");
		expect(get).not.toHaveBeenCalled();
		// AUD-11: una IPv6 cuenta por su /64, como en los demás filtros.
		expect(claves).toEqual(["2001:db8:0:1::/64"]);
	});

	it("lo que ya está en la caché del worker no cuenta", async () => {
		const tenant = negocio();
		const rel = ruta("categorias", "png");
		await subir(tenant, rel, PNG);
		const url = `https://tpv.test/v1/images/${tenant}/${rel}`;
		let consultas = 0;
		const abierto = { limit: async () => (consultas++, { success: true }) };
		const lleno = { limit: async () => (consultas++, { success: false }) };

		const ctx = createExecutionContext();
		const primera = await app.fetch(new Request(url), { ...env, LIMITADOR_IMAGENES: abierto }, ctx);
		expect(primera.status).toBe(200);
		await primera.arrayBuffer();
		await waitOnExecutionContext(ctx);
		expect(consultas).toBe(1);

		const ctx2 = createExecutionContext();
		const segunda = await app.fetch(new Request(url), { ...env, LIMITADOR_IMAGENES: lleno }, ctx2);
		await waitOnExecutionContext(ctx2);
		expect(segunda.status).toBe(200);
		expect(new Uint8Array(await segunda.arrayBuffer())).toEqual(PNG);
		expect(consultas).toBe(1);
	});
});
