// AUD-31 · La pantalla sólo pinta una imagen con la forma que genera la app.
//
// El logo (`Logo_DataUrl`) y la imagen de un producto, categoría o proveedor (`Ruta_Imagen`) llegan
// replicados y los puede escribir quien saque las credenciales de una Handy. `resolveImageUrl`
// devolvía tal cual un `data:`, una URL absoluta y lo que empezara por «/», y hacía una URL `asset:`
// de una ruta que Rust rechazaba. Ahora sólo sale una URL para una ruta de `save_image`
// (`images/{carpeta}/{uuid}.{ext}`) o un icono de alérgeno de la app; lo demás es "" (el marcador).
import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke, convertFileSrc: (ruta: string) => `asset:${ruta}` }));
vi.mock("@tauri-apps/api/path", () => ({ appDataDir: async () => "appdata", join: async (...partes: string[]) => partes.join("/") }));
import { limpiarCacheImagenes, resolveImageUrl } from "../src/shared/lib/imageUrl";
import { useMode } from "../src/shared/stores/useMode";

const SIN_FORMA = [
    "data:image/png;base64,AAAA",
    "DATA:image/svg+xml,<svg/>",
    "https://example.invalid/x.png",
    "//example.invalid/x.png",
    "http://asset.localhost/x.png",
    "asset://localhost/x.png",
    "blob:http://localhost/x",
    "/otra/cosa.png",
    "/alergenos/../data.db",
    "data.db",
    "images/logo/a.png",
];
const LOGO = "images/logo/0190f3a1-7b2c-4d4e-8f00-123456789abc.png";

beforeEach(() => { h.invoke.mockReset(); limpiarCacheImagenes(); });

describe("AUD-31 · Main", () => {
    beforeEach(() => { useMode.setState({ mode: "tpv" }); });

    it.each(SIN_FORMA)("%s no llega al <img> ni se le pide a Rust", async (valor) => {
        h.invoke.mockResolvedValue(true);
        expect(await resolveImageUrl(valor)).toBe("");
        expect(h.invoke).not.toHaveBeenCalled();
    });

    it("una ruta que Rust rechaza o que no está en disco no da una URL asset:", async () => {
        h.invoke.mockRejectedValue({ code: "validation", message: "La ruta de la imagen no es válida." });
        expect(await resolveImageUrl(LOGO)).toBe("");
        h.invoke.mockReset(); h.invoke.mockResolvedValue(false);
        expect(await resolveImageUrl(LOGO)).toBe("");
        // Y no se queda en la caché: en cuanto baja, se pinta.
        h.invoke.mockReset(); h.invoke.mockResolvedValue(true);
        expect(await resolveImageUrl(LOGO)).toBe(`asset:appdata/${LOGO}`);
    });

    it("el icono de un alérgeno de la app se sigue pintando", async () => {
        expect(await resolveImageUrl("/alergenos/gluten.png")).toBe("/alergenos/gluten.png");
        expect(await resolveImageUrl("/alergenos/frutos_cascara.png")).toBe("/alergenos/frutos_cascara.png");
        expect(h.invoke).not.toHaveBeenCalled();
    });
});

describe("AUD-31 · Handy", () => {
    beforeEach(() => { useMode.setState({ mode: "handy" }); });

    it.each(SIN_FORMA)("%s no llega al <img> ni se pide el negocio", async (valor) => {
        h.invoke.mockResolvedValue("https://tpv-api.altarialights.workers.dev/v1/images/negocio-a");
        expect(await resolveImageUrl(valor)).toBe("");
        expect(h.invoke).not.toHaveBeenCalled();
    });

    // INFRA-03: por el GET del worker, con la base que da `handy_url_imagenes`.
    it("una ruta de la app se pide al worker", async () => {
        h.invoke.mockResolvedValue("https://tpv-api.altarialights.workers.dev/v1/images/negocio-a");
        expect(await resolveImageUrl(LOGO)).toBe(`https://tpv-api.altarialights.workers.dev/v1/images/negocio-a/${LOGO}`);
        expect(h.invoke).toHaveBeenCalledWith("handy_url_imagenes", undefined);
    });
});
