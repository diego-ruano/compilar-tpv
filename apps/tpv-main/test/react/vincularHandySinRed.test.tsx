/** @vitest-environment jsdom */
// CFG-INC-04: sin red, «Regenerar código» y «Generar nuevo» se podían pulsar, no hacían nada que se
// viera (el aviso de «Necesitas conexión» tapa el error) y el error, de llegar a verse, era el texto
// de reqwest en inglés. Ahora se apagan y dicen por qué.
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
