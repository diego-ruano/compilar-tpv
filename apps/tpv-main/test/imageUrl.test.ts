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
/** INFRA-03: lo que contesta `handy_url_imagenes` (Rust, sobre `CLOUD_API_BASE`) para un negocio. */
const WORKER = "https://tpv-api.altarialights.workers.dev";
const base = (negocio: string) => `${WORKER}/v1/images/${negocio}`;
beforeEach(() => { h.invoke.mockReset(); limpiarCacheImagenes(); useMode.setState({mode: "handy"}); });
describe("imágenes al cambiar de vínculo", () => {
    it("la misma ruta relativa se resuelve con el negocio actual", async () => {
        h.invoke.mockResolvedValue(base("negocio-a"));
        expect(await resolveImageUrl(MISMA)).toContain("/negocio-a/");
        limpiarCacheImagenes(); h.invoke.mockResolvedValue(base("negocio-b"));
        expect(await resolveImageUrl(MISMA)).toContain("/negocio-b/");
    });
    it("una resolución tardía no repuebla la caché con el negocio anterior", async () => {
        let resolver!: (url: string) => void;
        h.invoke.mockReturnValueOnce(new Promise((resolve) => { resolver = resolve; })).mockResolvedValue(base("negocio-b"));
        const anterior = resolveImageUrl(LOGO);
        limpiarCacheImagenes();
        expect(await resolveImageUrl(LOGO)).toContain("/negocio-b/");
        resolver(base("negocio-a")); expect(await anterior).toBe("");
        expect(await resolveImageUrl(LOGO)).toContain("/negocio-b/");
    });
    it("pasar a Main descarta la URL del worker y vuelve a resolver el fichero local", async () => {
        h.invoke.mockResolvedValue(base("negocio-a")); await resolveImageUrl(P);
        limpiarCacheImagenes(); useMode.setState({mode: "tpv"}); h.invoke.mockResolvedValue(true);
        expect(await resolveImageUrl(P)).toBe(`asset:appdata/${P}`);
    });
    it("OBS-06: la Handy no pide al worker una imagen cuyo nombre no sea el UUID de la app", async () => {
        h.invoke.mockResolvedValue(base("negocio-a"));
        for (const ruta of ["images/proveedores/Juan-Perez.jpg", "images/productos/tarta.png", "images/otra/x.jpg", P.replace("productos", "PRODUCTOS"), P.replace("images", "IMAGES")]) {
            expect(await resolveImageUrl(ruta), ruta).toBe("");
        }
        expect(h.invoke).not.toHaveBeenCalled();
        expect(await resolveImageUrl(P)).toContain(`/negocio-a/${P}`);
    });
    it("una ruta que empieza por «/» es de la aplicación: ni AppData ni worker", async () => {
        expect(await resolveImageUrl("/alergenos/gluten.png")).toBe("/alergenos/gluten.png");
        useMode.setState({mode: "tpv"});
        expect(await resolveImageUrl("/alergenos/gluten.png")).toBe("/alergenos/gluten.png");
        expect(h.invoke).not.toHaveBeenCalled();
    });
});

// INFRA-03 · La Handy pinta las imágenes por el GET público del worker
// (`/v1/images/{tenant}/{ruta}`, `domains/images/images.routes.ts`) y no por el `r2.dev` del bucket.
// La base, con el negocio, la da Rust (`handy_url_imagenes`): aquí sólo se le pega la ruta.
describe("INFRA-03 · las imágenes de la Handy salen del worker", () => {
    const comandos = () => h.invoke.mock.calls.map((c) => c[0]);
    const responder = (url: string | null) => h.invoke.mockImplementation(async (comando: string) => {
        if (comando === "handy_url_imagenes") return url;
        throw { code: "internal", message: `comando inesperado: ${comando}` };
    });

    it("compone {worker}/v1/images/{negocio}/{Ruta_Imagen}, la forma exacta del GET", async () => {
        responder(base("0190f3a1-7b2c-4d4e-8f00-00000000cafe"));
        expect(await resolveImageUrl(P)).toBe(`${WORKER}/v1/images/0190f3a1-7b2c-4d4e-8f00-00000000cafe/${P}`);
        expect(comandos()).toEqual(["handy_url_imagenes"]);
    });

    it("pide la base una sola vez y da siempre el mismo URL (la caché de la webview cuenta con ello)", async () => {
        responder(base("negocio-a"));
        const primera = await resolveImageUrl(P);
        expect(await resolveImageUrl(P)).toBe(primera);
        expect(await resolveImageUrl(MISMA)).toBe(`${base("negocio-a")}/${MISMA}`);
        expect(comandos()).toEqual(["handy_url_imagenes"]);
    });

    it("nunca sale una dirección de r2.dev", async () => {
        responder(base("negocio-a"));
        for (const ruta of [P, MISMA, LOGO]) {
            const url = await resolveImageUrl(ruta);
            expect(url.startsWith(`${WORKER}/v1/images/negocio-a/`), url).toBe(true);
            expect(url).not.toContain("r2.dev");
        }
    });

    it("sin vínculo, o si Rust no contesta, no hay URL (el marcador)", async () => {
        responder(null);
        expect(await resolveImageUrl(P)).toBe("");
        limpiarCacheImagenes();
        h.invoke.mockReset(); h.invoke.mockRejectedValue({ code: "external", message: "El almacén no contesta." });
        expect(await resolveImageUrl(P)).toBe("");
    });

    it("una ruta que no es de la app no se pide ni llega al worker", async () => {
        responder(base("negocio-a"));
        for (const ruta of ["images/productos/tarta.png", "data:image/png;base64,AAAA", "https://example.invalid/x.png", "images/logo/../../x.png"]) {
            expect(await resolveImageUrl(ruta), ruta).toBe("");
        }
        expect(h.invoke).not.toHaveBeenCalled();
    });

    it("la Main sigue con su fichero local y no pide la base del worker", async () => {
        useMode.setState({ mode: "tpv" });
        h.invoke.mockImplementation(async (comando: string) => comando === "images_ensure_local");
        expect(await resolveImageUrl(P)).toBe(`asset:appdata/${P}`);
        expect(comandos()).toEqual(["images_ensure_local"]);
    });
});
