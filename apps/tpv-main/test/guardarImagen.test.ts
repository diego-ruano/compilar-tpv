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

	it("los selectores de fichero ofrecen también WebP", () => {
		expect(ACEPTA_IMAGENES.split(",")).toEqual(expect.arrayContaining(["image/webp", ".webp", "image/jpeg", "image/png"]));
	});
});
