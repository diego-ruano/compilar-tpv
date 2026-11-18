/** @vitest-environment jsdom */
// Vincular una Handy escaneando con la cámara el QR de la Main (plugin `barcode-scanner`, sólo en
// móvil). Lo leído sigue el mismo camino que pegarlo; si se deniega el permiso o se cancela, se
// avisa y siguen las otras vías. El plugin se sustituye: aquí no hay cámara.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { codigoParaVincular, contenidoDelQr } from "../../src/app/arranque/emparejamiento";

const camara = vi.hoisted(() => ({
    permiso: "granted" as string,
    alPedir: "granted" as string,
    scan: vi.fn(),
    cancel: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/plugin-barcode-scanner", () => ({
    Format: { QRCode: "QR_CODE" },
    checkPermissions: async () => camara.permiso,
    requestPermissions: async () => camara.alPedir,
    scan: camara.scan,
    cancel: camara.cancel,
}));

const { default: EmparejarHandy } = await import("../../src/app/arranque/EmparejarHandy");
const { EscaneoQr } = await import("../../src/app/arranque/escanearQr");

function emparejamiento() {
    return {
        estado: { step: "idle" as const },
        ocupado: false,
        error: null,
        huella: "",
        hayVinculoGuardado: false,
        vincular: vi.fn(),
        cancelar: vi.fn(),
        volverAVincular: vi.fn(),
    };
}

beforeEach(() => {
    camara.permiso = "granted";
    camara.alPedir = "granted";
    camara.scan.mockReset();
    camara.cancel.mockClear();
});
afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
});

describe("lo que lleva el QR de la Main", () => {
    it("es lo que acepta el campo de pegar, también con un secreto con + / =", () => {
        for (const secreto of ["abc", "q+/Wd9==", "a b&c=d?e"]) {
            const contenido = contenidoDelQr("012345", secreto);
            expect(codigoParaVincular(contenido, "")).toEqual({ pairCode: "012345", pairSecret: secreto });
        }
    });
});

describe("en el teléfono", () => {
    beforeEach(() => vi.stubEnv("TAURI_ENV_PLATFORM", "android"));

    it("lo escaneado se vincula igual que si se hubiera pegado", async () => {
        const contenido = contenidoDelQr("654321", "q+/Wd9==");
        camara.scan.mockResolvedValue({ content: contenido, format: "QR_CODE", bounds: null });
        const e = emparejamiento();
        render(<EmparejarHandy emparejamiento={e} volviendo={false} onVolver={() => {}} />);

        fireEvent.click(await screen.findByRole("button", { name: "Escanear el QR" }));
        await waitFor(() => expect(e.vincular).toHaveBeenCalledWith(contenido, ""));
        expect(camara.scan).toHaveBeenCalledWith({ windowed: true, formats: ["QR_CODE"] });
        expect(screen.getByLabelText("Contenido del QR")).toHaveValue(contenido);
        expect(document.documentElement.classList.contains("escaneando-qr")).toBe(false);
    });

    it("sin permiso de la cámara avisa y no escanea", async () => {
        camara.permiso = "prompt";
        camara.alPedir = "denied";
        const e = emparejamiento();
        render(<EmparejarHandy emparejamiento={e} volviendo={false} onVolver={() => {}} />);

        fireEvent.click(await screen.findByRole("button", { name: "Escanear el QR" }));
        expect(await screen.findByText(/Sin permiso para usar la cámara/)).toBeInTheDocument();
        expect(camara.scan).not.toHaveBeenCalled();
        expect(e.vincular).not.toHaveBeenCalled();
        // Las otras vías siguen ahí.
        expect(screen.getByLabelText("Código manual")).toBeEnabled();
    });

    it("«Cancelar» en el visor cierra la cámara y lo dice", async () => {
        let rechazar!: (e: unknown) => void;
        camara.scan.mockReturnValue(new Promise((_, r) => { rechazar = r; }));
        camara.cancel.mockImplementation(async () => rechazar("cancelled"));
        const e = emparejamiento();
        render(<EmparejarHandy emparejamiento={e} volviendo={false} onVolver={() => {}} />);

        fireEvent.click(await screen.findByRole("button", { name: "Escanear el QR" }));
        const visor = await screen.findByRole("dialog", { name: "Escanear el QR" });
        expect(document.documentElement.classList.contains("escaneando-qr")).toBe(true);
        fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));

        expect(await screen.findByText(/No se ha escaneado ningún QR/)).toBeInTheDocument();
        expect(visor).not.toBeInTheDocument();
        expect(camara.cancel).toHaveBeenCalledTimes(1);
        expect(e.vincular).not.toHaveBeenCalled();
        expect(document.documentElement.classList.contains("escaneando-qr")).toBe(false);
    });

    it("cancelar mientras se pide el permiso no abre la cámara", async () => {
        // La pantalla se cierra mientras el sistema pregunta por la cámara.
        let responder: ((p: string) => void) | undefined;
        const scan = vi.fn(async () => ({ content: "x" }));
        const escaneo = new EscaneoQr(async () => ({
            Format: { QRCode: "QR_CODE" } as never,
            checkPermissions: async () => "prompt",
            requestPermissions: () => new Promise((r) => { responder = r; }),
            scan,
            cancel: async () => {},
        }) as never);
        const alEmpezar = vi.fn();

        const leyendo = escaneo.leer(alEmpezar);
        await waitFor(() => expect(responder).toBeDefined());
        await escaneo.cancelar();
        responder!("granted");

        expect(await leyendo).toEqual({ tipo: "cancelado" });
        expect(scan).not.toHaveBeenCalled();
        expect(alEmpezar).not.toHaveBeenCalled();
        expect(document.documentElement.classList.contains("escaneando-qr")).toBe(false);
    });

    it("un fallo de la cámara se cuenta, con su motivo", async () => {
        const r = await new EscaneoQr(async () => ({
            Format: { QRCode: "QR_CODE" } as never,
            checkPermissions: async () => "granted",
            requestPermissions: async () => "granted",
            scan: async () => { throw "No hay cámara"; },
            cancel: async () => {},
        })).leer(() => {});
        expect(r).toEqual({ tipo: "error", motivo: "No hay cámara" });
    });
});

it("en el escritorio no hay botón de escanear", async () => {
    vi.stubEnv("TAURI_ENV_PLATFORM", "windows");
    render(<EmparejarHandy emparejamiento={emparejamiento()} volviendo={false} onVolver={() => {}} />);
    await screen.findByText("Conecta este Handy");
    expect(screen.queryByRole("button", { name: "Escanear el QR" })).not.toBeInTheDocument();
});
