// test/imagenesCotas.test.ts
//
// AUD-31 · Lo que se sube a R2 cabe en las cotas de RI-07.
//
// La Handy pinta desde r2.dev los bytes que haya en el bucket, y la Main los baja. El PUT sólo
// miraba la firma del dispositivo, los 5 MB y que el contenido fuera de la clase que dice la
// extensión: un PNG que declara 8193 px de ancho, o un WebP, entraban. Ahora la cabecera tiene que
// decir sus dimensiones, como mucho 8192 px de lado y 24 Mpx (lo que decodifica la Main,
// `imagenes::decodificar`), y WebP no se admite.

import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/middleware/tenant", () => ({
	tenantAuth: async (c: any, next: () => Promise<void>) => {
		c.set("tenantId", "negocio-cotas");
		await next();
	},
}));

import type { Env } from "../src/env";
import { dentroDeLasCotas, dimensionesDeImagen, imagesRoutes } from "../src/domains/images/images.routes";

const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n: number) => [(n >>> 8) & 255, n & 255];

/** La cabecera de un PNG: firma e IHDR. No hace falta más para saber lo que declara. */
function png(ancho: number, alto: number): Uint8Array {
	return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, ...u32(ancho), ...u32(alto), 8, 6, 0, 0, 0, 0, 0, 0, 0]);
}

/** Un JPEG con un APP0 delante del SOF0 (como lo escribe cualquier codificador). */
function jpeg(ancho: number, alto: number, sof = 0xc0): Uint8Array {
	const app0 = [0xff, 0xe0, ...u16(16), 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
	const sof0 = [0xff, sof, ...u16(17), 8, ...u16(alto), ...u16(ancho), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
	return new Uint8Array([0xff, 0xd8, ...app0, ...sof0, 0xff, 0xd9]);
}

const WEBP = new Uint8Array([82, 73, 70, 70, 0x1a, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 76, 0x0d, 0, 0, 0, 0x2f, 0, 0, 0, 0x10]);

describe("AUD-31 · las dimensiones que declara la cabecera", () => {
	it("se leen de un PNG y de un JPEG", () => {
		expect(dimensionesDeImagen(png(640, 480))).toEqual({ ancho: 640, alto: 480 });
		expect(dimensionesDeImagen(jpeg(1024, 768))).toEqual({ ancho: 1024, alto: 768 });
		expect(dimensionesDeImagen(jpeg(300, 200, 0xc2))).toEqual({ ancho: 300, alto: 200 });
	});

	it("caben: hasta 8192 px de lado y 24 Mpx", () => {
		expect(dentroDeLasCotas(png(1024, 1024))).toBe(true);
		expect(dentroDeLasCotas(png(8192, 2929))).toBe(true);
		expect(dentroDeLasCotas(jpeg(4000, 6000))).toBe(true);
	});

	it("no caben: un lado de más, demasiados píxeles, cero o sin cabecera", () => {
		expect(dentroDeLasCotas(png(8193, 1))).toBe(false);
		expect(dentroDeLasCotas(png(1, 8193))).toBe(false);
		expect(dentroDeLasCotas(png(5000, 5000))).toBe(false);
		expect(dentroDeLasCotas(png(0xffffffff, 0xffffffff))).toBe(false);
		expect(dentroDeLasCotas(png(0, 10))).toBe(false);
		expect(dentroDeLasCotas(jpeg(65535, 65535))).toBe(false);
		expect(dentroDeLasCotas(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBe(false);
		expect(dentroDeLasCotas(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(false);
		expect(dentroDeLasCotas(WEBP)).toBe(false);
	});
});

describe("AUD-31 · PUT /v1/images", () => {
	function subir(ruta: string, cuerpo: Uint8Array) {
		const put = vi.fn(async () => ({}));
		const app = new Hono<{ Bindings: Env }>().route("/v1/images", imagesRoutes);
		const env = { IMAGES: { put } } as unknown as Env;
		const res = app.request(`https://api.test/v1/images/${ruta}`, { method: "PUT", body: cuerpo }, env);
		return { res, put };
	}
	const UUID = "0190f3a1-7b2c-4d4e-8f00-123456789abc";

	it("un PNG de 8193×1 no llega al bucket", async () => {
		const { res, put } = subir(`images/logo/${UUID}.png`, png(8193, 1));
		expect((await res).status).toBe(413);
		expect(await (await res).json()).toEqual({ error: "image_too_large" });
		expect(put).not.toHaveBeenCalled();
	});

	it("un JPEG de 30 Mpx tampoco", async () => {
		const { res, put } = subir(`images/productos/${UUID}.jpg`, jpeg(6000, 5000));
		expect((await res).status).toBe(413);
		expect(put).not.toHaveBeenCalled();
	});

	it("un WebP tampoco, aunque su ruta lo diga", async () => {
		const { res, put } = subir(`images/productos/${UUID}.webp`, WEBP);
		expect((await res).status).toBe(400);
		expect(put).not.toHaveBeenCalled();
	});

	it("lo que sube la app (1024 px como mucho) entra", async () => {
		for (const [ruta, cuerpo] of [[`images/logo/${UUID}.png`, png(1024, 512)], [`images/productos/${UUID}.jpg`, jpeg(1024, 1024)]] as const) {
			const { res, put } = subir(ruta, cuerpo);
			expect((await res).status, ruta).toBe(200);
			expect(put).toHaveBeenCalledTimes(1);
		}
	});
});
