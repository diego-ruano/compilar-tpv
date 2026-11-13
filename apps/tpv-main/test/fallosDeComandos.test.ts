import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("../src/shared/observability/sentry", () => ({ capturarFalloDeComando: vi.fn() }));

import { alFallarUnComando, commands, yaRegistrado, type AppErrorDto, type FalloAlInvocar } from "@tpv/client";
import type { FalloDeComando } from "@tpv/contracts";
import { crearRegistroDeFallos, VENTANA_MS } from "../src/shared/observability/fallosDeComandos";

const fallo = (comando: string, code: AppErrorDto["code"], message = "texto"): FalloAlInvocar => ({
    comando,
    error: { code, message },
    duracionMs: 12,
});

describe("el registro de los fallos de comandos", () => {
    let contados: FalloDeComando[];
    let aSentry: FalloDeComando[];
    let registrar: (f: FalloAlInvocar) => void;

    beforeEach(() => {
        vi.useFakeTimers();
        contados = [];
        aSentry = [];
        registrar = crearRegistroDeFallos({
            contar: async (f) => { contados.push(f); },
            aSentry: (f) => { aSentry.push(f); },
            pantalla: () => "/mesas",
        });
    });

    afterEach(() => vi.useRealTimers());

    it("un fallo del programa se cuenta con su mensaje y va a Sentry", () => {
        registrar(fallo("cobrar_detalles", "internal", "database is locked"));

        expect(contados).toEqual([{
            comando: "cobrar_detalles",
            code: "internal",
            gravedad: "programa",
            mensaje: "database is locked",
            pantalla: "/mesas",
            duracion_ms: 12,
            veces: 1,
        }]);
        expect(aSentry).toHaveLength(1);
    });

    it("lo del entorno se cuenta con su mensaje, pero no es un fallo del programa", () => {
        registrar(fallo("printer_imprimir_pago", "external", "La impresora está sin papel"));

        expect(contados[0]).toMatchObject({ gravedad: "entorno", mensaje: "La impresora está sin papel" });
        expect(aSentry).toHaveLength(0);
    });

    it("una respuesta esperada se cuenta sin el mensaje, que puede llevar lo que escribió alguien", () => {
        registrar(fallo("clientes_create", "validation", "Ya existe un cliente llamado Ana"));

        expect(contados[0]).toMatchObject({ gravedad: "normal", mensaje: null });
        expect(aSentry).toHaveLength(0);
    });

    it("lo que una Handy no tiene porque es de la Main no es un fallo del programa", () => {
        // Rust lo contesta como `conflict`, no como `internal`: el equipo no admite la operación.
        registrar(fallo("verifactu_estado", "conflict", "Los registros de facturación sólo existen en el TPV principal"));

        expect(contados[0]).toMatchObject({ gravedad: "normal", mensaje: null });
        expect(aSentry).toHaveLength(0);
    });

    it("la espera de la aprobación de una Handy no es un fallo", () => {
        registrar(fallo("pair_status", "not_approved"));

        expect(contados).toHaveLength(0);
    });

    it("el fallo del propio registro no se cuenta: sería un bucle", () => {
        registrar(fallo("telemetria_fallo_de_comando", "internal"));

        expect(contados).toHaveLength(0);
        expect(aSentry).toHaveLength(0);
    });

    it("una racha del mismo fallo sale una vez, y el resto junto al cerrar la ventana", () => {
        for (let i = 0; i < 5; i++) registrar(fallo("sync_reintentar", "internal"));

        expect(contados).toHaveLength(1);
        expect(aSentry).toHaveLength(1);

        vi.advanceTimersByTime(VENTANA_MS);

        expect(contados).toHaveLength(2);
        expect(contados[1]).toMatchObject({ comando: "sync_reintentar", veces: 4 });
        expect(aSentry).toHaveLength(1);
    });

    it("pasada la ventana, el mismo fallo vuelve a salir; otro comando nunca espera", () => {
        registrar(fallo("sync_reintentar", "internal"));
        registrar(fallo("printer_print_test", "internal"));
        expect(contados).toHaveLength(2);

        vi.advanceTimersByTime(VENTANA_MS);
        registrar(fallo("sync_reintentar", "internal"));

        expect(contados).toHaveLength(3);
        expect(contados[2]).toMatchObject({ comando: "sync_reintentar", veces: 1 });
    });

    it("si no se puede contar, no sale ningún fallo nuevo", async () => {
        const sinRegistro = crearRegistroDeFallos({
            contar: () => Promise.reject(new Error("sin Tauri")),
            aSentry: () => {},
            pantalla: () => null,
        });
        const rechazos = vi.fn();
        process.on("unhandledRejection", rechazos);

        sinRegistro(fallo("cobrar_detalles", "internal"));
        await vi.runAllTimersAsync();

        process.off("unhandledRejection", rechazos);
        expect(rechazos).not.toHaveBeenCalled();
    });
});

describe("invocar", () => {
    afterEach(() => {
        alFallarUnComando(null);
        h.invoke.mockReset();
    });

    it("avisa del fallo de cualquier comando y lo marca como registrado", async () => {
        const avisos: FalloAlInvocar[] = [];
        alFallarUnComando((f) => avisos.push(f));
        h.invoke.mockRejectedValue({ code: "external", message: "La impresora está sin papel" });

        const error = await commands.printerPrintTest(null).catch((e: unknown) => e);

        expect(error).toEqual({ code: "external", message: "La impresora está sin papel" });
        expect(avisos).toEqual([expect.objectContaining({ comando: "printer_print_test", error })]);
        expect(yaRegistrado(error)).toBe(true);
    });

    it("si el registro falla, quien llamó recibe su error igual", async () => {
        alFallarUnComando(() => { throw new Error("roto"); });
        h.invoke.mockRejectedValue({ code: "validation", message: "Falta la mesa." });

        const error = await commands.printerPrintTest(null).catch((e: unknown) => e);

        expect(error).toEqual({ code: "validation", message: "Falta la mesa." });
        expect(yaRegistrado(error)).toBe(false);
    });

    it("sin nadie enganchado, un error no se da por registrado", async () => {
        h.invoke.mockRejectedValue("texto suelto");

        const error = await commands.printerPrintTest(null).catch((e: unknown) => e);

        expect(error).toEqual({ code: "internal", message: "texto suelto" });
        expect(yaRegistrado(error)).toBe(false);
    });
});
