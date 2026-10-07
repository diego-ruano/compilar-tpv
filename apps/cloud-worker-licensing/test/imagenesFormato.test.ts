import { describe, expect, it } from "vitest";
import { tipoImagen } from "../src/domains/images/images.routes";

describe("RI-07: imágenes por contenido", () => {
    it("distingue JPEG, PNG y WebP y rechaza HTML y SVG renombrados", () => {
        expect(tipoImagen(new Uint8Array([255,216,255]))).toBe("image/jpeg");
        expect(tipoImagen(new Uint8Array([137,80,78,71,13,10,26,10]))).toBe("image/png");
        expect(tipoImagen(new Uint8Array([82,73,70,70,0,0,0,0,87,69,66,80]))).toBe("image/webp");
        expect(tipoImagen(new TextEncoder().encode("<svg><script/></svg>"))).toBeNull();
        expect(tipoImagen(new TextEncoder().encode("<html>"))).toBeNull();
    });
});
