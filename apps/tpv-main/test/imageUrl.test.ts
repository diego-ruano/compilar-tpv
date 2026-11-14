import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke, convertFileSrc: (ruta: string) => `asset:${ruta}` }));
vi.mock("@tauri-apps/api/path", () => ({ appDataDir: async () => "appdata", join: async (...partes: string[]) => partes.join("/") }));
import { limpiarCacheImagenes, resolveImageUrl } from "../src/shared/lib/imageUrl";
import { useMode } from "../src/shared/stores/useMode";
// OBS-06: las rutas de imagen de la app llevan un UUID por nombre.
const MISMA = "images/productos/0190f3a1-7b2c-4d4e-8f00-123456789abc.png";
const LOGO = "images/logo/0190f3a1-7b2c-4d4e-8f00-0000000000aa.webp";
const P = "images/productos/0190f3a1-7b2c-4d4e-8f00-0000000000bb.jpg";
beforeEach(() => { h.invoke.mockReset(); limpiarCacheImagenes(); useMode.setState({mode: "handy"}); });
describe("imágenes al cambiar de vínculo", () => {
    it("la misma ruta relativa se resuelve con el negocio actual", async () => {
        h.invoke.mockResolvedValue("negocio-a");
        expect(await resolveImageUrl(MISMA)).toContain("/negocio-a/");
        limpiarCacheImagenes(); h.invoke.mockResolvedValue("negocio-b");
        expect(await resolveImageUrl(MISMA)).toContain("/negocio-b/");
    });
    it("una resolución tardía no repuebla la caché con el negocio anterior", async () => {
        let resolver!: (tenant: string) => void;
        h.invoke.mockReturnValueOnce(new Promise((resolve) => { resolver = resolve; })).mockResolvedValue("negocio-b");
        const anterior = resolveImageUrl(LOGO);
        limpiarCacheImagenes();
        expect(await resolveImageUrl(LOGO)).toContain("/negocio-b/");
        resolver("negocio-a"); expect(await anterior).toBe("");
        expect(await resolveImageUrl(LOGO)).toContain("/negocio-b/");
    });
    it("pasar a Main descarta la URL del CDN y vuelve a resolver el fichero local", async () => {
        h.invoke.mockResolvedValue("negocio-a"); await resolveImageUrl(P);
        limpiarCacheImagenes(); useMode.setState({mode: "tpv"}); h.invoke.mockResolvedValue(true);
        expect(await resolveImageUrl(P)).toBe(`asset:appdata/${P}`);
    });
    it("OBS-06: la Handy no pide a r2.dev una imagen cuyo nombre no sea el UUID de la app", async () => {
        h.invoke.mockResolvedValue("negocio-a");
        for (const ruta of ["images/proveedores/Juan-Perez.jpg", "images/productos/tarta.png", "images/otra/x.jpg", P.replace("productos", "PRODUCTOS"), P.replace("images", "IMAGES")]) {
            expect(await resolveImageUrl(ruta), ruta).toBe("");
        }
        expect(h.invoke).not.toHaveBeenCalled();
        expect(await resolveImageUrl(P)).toContain(`/negocio-a/${P}`);
    });
    it("una ruta que empieza por «/» es de la aplicación: ni AppData ni CDN", async () => {
        expect(await resolveImageUrl("/alergenos/gluten.png")).toBe("/alergenos/gluten.png");
        useMode.setState({mode: "tpv"});
        expect(await resolveImageUrl("/alergenos/gluten.png")).toBe("/alergenos/gluten.png");
        expect(h.invoke).not.toHaveBeenCalled();
    });
});
