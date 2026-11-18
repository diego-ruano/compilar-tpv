/** @vitest-environment jsdom */
// Una Handy que se cierra esperando la aprobación deja su solicitud en la lista de la Main, y nadie
// pulsa «Cancelar». La espera se apunta en el almacenamiento de la aplicación mientras dura, y al
// volver a abrirse la Handy la suelta ella. La nube no la suelta por su cuenta: una Handy vinculada
// que vuelve a pedir el mismo negocio sigue conectada con su vínculo de antes mientras espera, y la
// lista de la Main dejaba de enseñar una solicitud que alguien seguía esperando.
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { esperaGuardada, guardarEspera, soltarEsperaAnterior } from "../../src/app/arranque/emparejamiento";
import { useEmparejamientoHandy } from "../../src/app/arranque/useEmparejamientoHandy";

const nube = vi.hoisted(() => ({
    llamadas: [] as { path: string; body: Record<string, unknown> }[],
    /** Si está, la cancelación no contesta hasta que se resuelve. */
    cancelacionEnVuelo: null as null | Promise<void>,
}));

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../../src/shared/observability/sentry", () => ({ captureException: vi.fn() }));

const CLAVE = "P".repeat(44);

beforeEach(() => {
    localStorage.clear();
    nube.llamadas = [];
    nube.cancelacionEnVuelo = null;
    invoke.mockReset();
    invoke.mockImplementation(async (comando: string, args: any) => {
        switch (comando) {
            case "handy_get_tenant":
                return "negocio-1";
            case "device_get_identity":
                return { deviceId: "h1", devicePubkeyB64: CLAVE };
            case "device_firmar_emparejamiento":
                return { ts: 1, sigB64: "firma" };
            case "tpv_server_post_json": {
                const { path, body } = args.args;
                nube.llamadas.push({ path, body });
                if (path === "/v1/pair/cancel") {
                    if (nube.cancelacionEnVuelo) await nube.cancelacionEnVuelo;
                    return { ok: true, liberado: true };
                }
                if (path === "/v1/pair/claim") return { nonceB64: "reto-nuevo", nonceExpiresAtMs: 9, caducaEnMs: 60_000 };
                if (path === "/v1/pair/fetch-token") throw { code: "not_approved", message: "pendiente" };
                throw new Error(`ruta inesperada ${path}`);
            }
            default:
                throw new Error(`comando inesperado: ${comando}`);
        }
    });
});
afterEach(cleanup);

const rutas = () => nube.llamadas.map((l) => l.path);

describe("la espera apuntada", () => {
    it("se suelta en la nube con su código y su reto, y se olvida", async () => {
        guardarEspera({ pairCode: "123456", nonceB64: "reto-viejo" });
        const deps = {
            commands: {
                deviceGetIdentity: async () => ({ deviceId: "h1", devicePubkeyB64: CLAVE }),
                deviceFirmarEmparejamiento: async () => ({ ts: 1, sigB64: "firma" }),
                handySetToken: async () => "OK",
            },
            pedirALaNube: vi.fn(async () => ({ ok: true })),
        };

        expect(await soltarEsperaAnterior(deps as any)).toBe(true);
        expect(deps.pedirALaNube).toHaveBeenCalledWith(
            "/v1/pair/cancel",
            expect.objectContaining({ pairCode: "123456", nonceB64: "reto-viejo", deviceId: "h1" }),
        );
        expect(esperaGuardada()).toBeNull();
        expect(await soltarEsperaAnterior(deps as any)).toBe(false);
        expect(deps.pedirALaNube).toHaveBeenCalledTimes(1);
    });

    it("no se apunta el secreto del código", () => {
        guardarEspera({ pairCode: "123456", nonceB64: "r", pairSecret: "secreto" } as any);
        expect(JSON.stringify(localStorage)).not.toContain("secreto");
    });
});

describe("la Handy", () => {
    it("al abrirse con una espera apuntada de la vez anterior, la suelta", async () => {
        guardarEspera({ pairCode: "123456", nonceB64: "reto-viejo" });

        const { result } = renderHook(() => useEmparejamientoHandy("handy"));

        await waitFor(() => expect(result.current.estado.step).toBe("paired"));
        await waitFor(() => expect(rutas()).toEqual(["/v1/pair/cancel"]));
        expect(nube.llamadas[0].body).toMatchObject({ pairCode: "123456", nonceB64: "reto-viejo" });
        expect(esperaGuardada()).toBeNull();
    });

    it("mientras espera la apunta, y «Cancelar» la olvida", async () => {
        const { result } = renderHook(() => useEmparejamientoHandy("handy"));
        await waitFor(() => expect(result.current.estado.step).toBe("paired"));

        // «← Vinculación» y otro código del mismo negocio.
        act(() => result.current.volverAVincular());
        act(() => result.current.vincular("", "654321"));
        await waitFor(() => expect(result.current.estado.step).toBe("waiting_approval"));
        expect(esperaGuardada()).toEqual({ pairCode: "654321", nonceB64: "reto-nuevo" });

        act(() => result.current.cancelar());
        expect(esperaGuardada()).toBeNull();
        await waitFor(() => expect(rutas()).toContain("/v1/pair/cancel"));
    });

    it("un código nuevo no se reclama hasta que se ha soltado la espera anterior", async () => {
        // La anterior era del mismo código: soltarla después del reclamo nuevo soltaría éste.
        guardarEspera({ pairCode: "123456", nonceB64: "reto-viejo" });
        let contestar!: () => void;
        nube.cancelacionEnVuelo = new Promise((r) => (contestar = r));

        const { result } = renderHook(() => useEmparejamientoHandy("handy"));
        await waitFor(() => expect(result.current.estado.step).toBe("paired"));
        act(() => result.current.volverAVincular());
        act(() => result.current.vincular("", "123456"));

        await new Promise((r) => setTimeout(r, 20));
        expect(rutas()).toEqual(["/v1/pair/cancel"]);

        contestar();
        await waitFor(() => expect(result.current.estado.step).toBe("waiting_approval"));
        expect(rutas()).toEqual(["/v1/pair/cancel", "/v1/pair/claim"]);
        act(() => result.current.cancelar());
    });
});
