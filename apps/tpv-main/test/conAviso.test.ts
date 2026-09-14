import { afterEach, describe, expect, it, vi } from "vitest";

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("../src/shared/observability/sentry", () => ({ captureException }));

import { conAviso } from "../src/shared/lib/conAviso";

// Deja correr las microtareas: el `catch` de la envoltura va detrás de la promesa.
const vaciarMicrotareas = () => new Promise((r) => setTimeout(r, 0));

describe("conAviso", () => {
    afterEach(() => {
        captureException.mockReset();
        vi.restoreAllMocks();
    });

    it("una promesa que rechaza se reporta y se avisa, en vez de perderse", async () => {
        const consola = vi.spyOn(console, "error").mockImplementation(() => {});
        const fallo = new Error("sin conexión");

        conAviso(() => Promise.reject(fallo), "No se pudo guardar")();
        await vaciarMicrotareas();

        expect(captureException).toHaveBeenCalledWith(fallo, { titulo: "No se pudo guardar" });
        // Sin ToastProvider montado, el aviso cae a la consola.
        expect(consola).toHaveBeenCalledWith("No se pudo guardar", fallo);
    });

    it("si la función no falla, no avisa de nada", async () => {
        const consola = vi.spyOn(console, "error").mockImplementation(() => {});

        conAviso(async () => {})();
        await vaciarMicrotareas();

        expect(captureException).not.toHaveBeenCalled();
        expect(consola).not.toHaveBeenCalled();
    });

    it("pasa los argumentos del evento a la función", () => {
        const fn = vi.fn(async (_a: number, _b: string) => {});

        conAviso(fn)(1, "dos");

        expect(fn).toHaveBeenCalledWith(1, "dos");
    });
});
