// test/guardarImagen.test.ts
//
// Una imagen WebP se puede elegir (fotos de móvil y de la web vienen así). Rust no decodifica WebP
// (AUD-30), así que la convierte la WebView antes de mandarla a `save_image`; JPEG y PNG pasan tal
// cual, y Rust los reconstruye como siempre (RI-07).

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ saveImage: vi.fn() }));
vi.mock("@tpv/client", () => ({ commands: { saveImage: h.saveImage } }));

import { ACEPTA_IMAGENES, guardarImagen } from "../src/shared/lib/guardarImagen";

/** Un WebP sin pérdida de 1×1, correcto. */
const WEBP = new Uint8Array([
	82, 73, 70, 70, 0x1a, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 76, 0x0d, 0, 0, 0, 0x2f, 0, 0, 0, 0x10, 0x07, 0x10, 0x11,
	0x11, 0x88, 0x88, 0xfe, 0x07, 0,
]);
/** La cabecera de un PNG (lo que devuelve el conversor de mentira). */
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const JPEG = new Uint8Array([255, 216, 255, 224, 0, 16, 1, 2]);

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

beforeEach(() => {
	h.saveImage.mockReset();
	h.saveImage.mockResolvedValue("images/productos/0190f3a1-7b2c-4d4e-8f00-123456789abc.png");
});

describe("guardarImagen", () => {
	it("un WebP lo convierte la WebView y a Rust le llega lo convertido", async () => {
		const convertir = vi.fn(async () => new Blob([PNG], { type: "image/png" }));
		const r = await guardarImagen(new File([WEBP], "foto.webp", { type: "image/webp" }), "productos", convertir);
		expect(convertir).toHaveBeenCalledOnce();
		expect(h.saveImage).toHaveBeenCalledWith({ subfolder: "productos", base64_data: base64(PNG) });
		expect(r.ruta).toBe("images/productos/0190f3a1-7b2c-4d4e-8f00-123456789abc.png");
	});

	it("se reconoce por sus bytes, aunque el nombre diga otra cosa", async () => {
		const convertir = vi.fn(async () => new Blob([PNG], { type: "image/png" }));
		await guardarImagen(new File([WEBP], "foto.jpg"), "logo", convertir);
		expect(convertir).toHaveBeenCalledOnce();
		expect(h.saveImage).toHaveBeenCalledWith({ subfolder: "logo", base64_data: base64(PNG) });
	});

	it("un JPEG o un PNG pasa tal cual", async () => {
		const convertir = vi.fn();
		for (const [bytes, nombre] of [[JPEG, "a.JPG"], [PNG, "b.png"]] as const) {
			await guardarImagen(new File([bytes], nombre), "categorias", convertir);
			expect(h.saveImage).toHaveBeenLastCalledWith({ subfolder: "categorias", base64_data: base64(bytes) });
		}
		expect(convertir).not.toHaveBeenCalled();
	});

	it("rechaza lo que no es JPEG, PNG ni WebP, y lo que pesa más de 5 MB", async () => {
		await expect(guardarImagen(new File([PNG], "a.gif"), "productos")).rejects.toThrow("Solo se admiten imágenes JPEG, PNG y WebP.");
		await expect(guardarImagen(new File([new Uint8Array(5 * 1024 * 1024 + 1)], "a.webp"), "productos")).rejects.toThrow("5 MB");
		expect(h.saveImage).not.toHaveBeenCalled();
	});

	it("si la WebView no la puede convertir, dice qué hacer", async () => {
		const convertir = vi.fn(async () => { throw new Error("decode"); });
		await expect(guardarImagen(new File([WEBP], "foto.webp"), "productos", convertir)).rejects.toThrow(
			"No se pudo leer la imagen WebP: prueba con otra o guárdala como JPEG o PNG.",
		);
		expect(h.saveImage).not.toHaveBeenCalled();
	});

	// Las cotas de RI-07 (`imagenes::decodificar`) valen también para un WebP, y se miran en su
	// cabecera antes de que la WebView reserve los píxeles: unos pocos bytes pueden declarar un
	// lienzo de 16384 × 16384, un giga decodificado.
	describe("un WebP que declara demasiados píxeles no llega a decodificarse", () => {
		const riff = (chunk: string, datos: number[]) => {
			const cuerpo = [...[...chunk].map((c) => c.charCodeAt(0)), datos.length, 0, 0, 0, ...datos];
			const total = 4 + cuerpo.length;
			return new Uint8Array([82, 73, 70, 70, total & 0xff, total >> 8, 0, 0, 87, 69, 66, 80, ...cuerpo]);
		};
		/** VP8L: firma 0x2f y 14 bits de ancho − 1 y 14 de alto − 1. */
		const vp8l = (ancho: number, alto: number) => {
			const v = (ancho - 1) | ((alto - 1) << 14);
			return riff("VP8L", [0x2f, v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff, 0, 0, 0]);
		};
		/** VP8X: banderas, tres reservados y 24 bits de ancho − 1 y de alto − 1. */
		const vp8x = (ancho: number, alto: number) => {
			const a = ancho - 1;
			const b = alto - 1;
			return riff("VP8X", [0x10, 0, 0, 0, a & 0xff, (a >> 8) & 0xff, a >> 16, b & 0xff, (b >> 8) & 0xff, b >> 16]);
		};
		/** VP8 con pérdida: etiqueta de 3 bytes, el código 9d 01 2a y 14 bits de ancho y de alto. */
		const vp8 = (ancho: number, alto: number) =>
			riff("VP8 ", [0x50, 0x01, 0x00, 0x9d, 0x01, 0x2a, ancho & 0xff, ancho >> 8, alto & 0xff, alto >> 8]);

		it.each([
			["VP8L de 16384 × 16384", vp8l(16384, 16384)],
			["VP8L de 8193 × 1", vp8l(8193, 1)],
			["VP8X de 9000 × 100", vp8x(9000, 100)],
			["VP8X de 6000 × 5000 (30 Mpx)", vp8x(6000, 5000)],
			["VP8 de 1 × 8200", vp8(1, 8200)],
		])("%s", async (_nombre, bytes) => {
			const convertir = vi.fn(async () => new Blob([PNG], { type: "image/png" }));
			await expect(guardarImagen(new File([bytes], "foto.webp"), "productos", convertir)).rejects.toThrow(
				"La imagen tiene demasiados píxeles: como mucho 8192 de lado y 24 millones en total.",
			);
			expect(convertir).not.toHaveBeenCalled();
			expect(h.saveImage).not.toHaveBeenCalled();
		});

		it("dentro de las cotas, sí", async () => {
			for (const bytes of [vp8l(8192, 2929), vp8x(4000, 6000), vp8(1024, 768), WEBP]) {
				const convertir = vi.fn(async () => new Blob([PNG], { type: "image/png" }));
				await guardarImagen(new File([bytes], "foto.webp"), "productos", convertir);
				expect(convertir).toHaveBeenCalledOnce();
			}
		});

		it("una cabecera que no se entiende no se le pasa a la WebView", async () => {
			const convertir = vi.fn(async () => new Blob([PNG], { type: "image/png" }));
			for (const bytes of [riff("VP8Z", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), riff("VP8L", [0x00, 0, 0, 0, 0]), WEBP.slice(0, 16)]) {
				await expect(guardarImagen(new File([bytes], "foto.webp"), "productos", convertir)).rejects.toThrow(
					"No se pudo leer la imagen WebP: prueba con otra o guárdala como JPEG o PNG.",
				);
			}
			expect(convertir).not.toHaveBeenCalled();
		});
	});

	it("los selectores de fichero ofrecen también WebP", () => {
		expect(ACEPTA_IMAGENES.split(",")).toEqual(expect.arrayContaining(["image/webp", ".webp", "image/jpeg", "image/png"]));
	});
});
