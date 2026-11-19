/** @vitest-environment jsdom */
// CFG-INC-04: sin red, «Regenerar código» y «Generar nuevo» se podían pulsar, no hacían nada que se
// viera (el aviso de «Necesitas conexión» tapa el error) y el error, de llegar a verse, era el texto
// de reqwest en inglés. Ahora se apagan y dicen por qué.
import { readFileSync } from "node:fs";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const pareo = vi.hoisted(() => ({ regenerar: vi.fn(async () => {}), asegurar: vi.fn(async () => {}) }));
vi.mock("../../src/features/configuracion/pairingQueries", () => {
    const consulta = { data: [], isError: false, error: null };
    const mutacion = { mutate: vi.fn(), isPending: false, isError: false, error: null, variables: undefined };
    return {
        usePairPendientes: () => consulta,
        useDispositivosVinculados: () => consulta,
        useAprobarHandy: () => mutacion,
        useRechazarHandy: () => mutacion,
        useRevocarHandy: () => mutacion,
    };
});

const { useEstadoSync } = await import("../../src/shared/stores/useEstadoSync");
const { usePairCode } = await import("../../src/shared/stores/usePairCode");
const { VincularHandy } = await import("../../src/features/configuracion/sections/VincularHandy");

beforeEach(() => {
    usePairCode.setState({ code: "", secret: "", expiresAtMs: null, loading: false, error: null, regenerar: pareo.regenerar, asegurar: pareo.asegurar });
});
afterEach(cleanup);

it("sin conexión, los botones que piden un código se apagan y dicen por qué", async () => {
    useEstadoSync.setState({ estado: "reintentando" });
    render(<VincularHandy darkMode={false} />);
    for (const nombre of ["Generar nuevo", "Regenerar código"]) {
        const boton = await screen.findByRole("button", { name: nombre });
        expect(boton).toBeDisabled();
        expect(boton).toHaveAttribute("title", "Sin conexión a internet no se puede pedir un código nuevo.");
    }
    expect(pareo.asegurar).not.toHaveBeenCalled();
});

it("con conexión se pueden pulsar", async () => {
    useEstadoSync.setState({ estado: "conectado" });
    render(<VincularHandy darkMode={false} />);
    for (const nombre of ["Generar nuevo", "Regenerar código"]) {
        const boton = await screen.findByRole("button", { name: nombre });
        expect(boton).toBeEnabled();
        expect(boton).not.toHaveAttribute("title");
    }
});

// El panel decía «Configuración → "Vincular dispositivo" y escanea», y en la Handy no hay nada así:
// se vincula desde «Conecta este Handy», a la que se llega eligiendo «Handy» al abrir la app o, si ya
// estaba vinculada, desvinculándola en su Configuración («Dispositivo»). Cada botón o pantalla que el
// panel nombra entre comillas tiene que existir en la Handy.
it("lo que el panel dice que se pulse en el Handy existe en el Handy", async () => {
    useEstadoSync.setState({ estado: "conectado" });
    const { container } = render(<VincularHandy darkMode={false} />);
    await screen.findByText("Pasos");
    const texto = container.textContent ?? "";
    expect(texto).not.toContain("Configuración →");

    const handy = [
        "../../src/app/arranque/EmparejarHandy.tsx",
        "../../src/app/arranque/SelectorModo.tsx",
        "../../src/app/AppBoot.tsx",
        "../../src/app/pages/Configuracion.tsx",
        "../../src/features/configuracion/sections/Dispositivo.tsx",
    ]
        .map((f) => readFileSync(new URL(f, import.meta.url), "utf8"))
        .join("\n");
    const nombrados = [...texto.matchAll(/«([^»]+)»/g)].map((m) => m[1]!);
    expect(nombrados).toEqual(
        expect.arrayContaining(["Conecta este Handy", "Vincular dispositivo", "Dispositivo", "Desvincular este dispositivo"]),
    );
    for (const nombre of nombrados) expect(handy, nombre).toContain(nombre);
});
