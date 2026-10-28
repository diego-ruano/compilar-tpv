/** @vitest-environment jsdom */
// RI-77: la Handy enseña la pantalla de Licencia, pero con lo que le toca a ella: la licencia es la
// del TPV principal. Lo que quede guardado de cuando el equipo fue Main no es la licencia de ahora.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Licencia } from "../../src/features/configuracion/sections/Licencia";
import { useMode } from "../../src/shared/stores/useMode";
import { ToastProvider } from "../../src/shared/toast";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const guardada = { status: "active", expires_at_ms: Date.now() + 90 * 86_400_000 };

beforeEach(() => invoke.mockReset());
afterEach(cleanup);

// En la Main, Licencia lleva también las copias de seguridad, que avisan con toasts.
const pintar = () => render(<ToastProvider><Licencia darkMode={false} /></ToastProvider>);

it("en la Handy explica que la licencia es de la Main, aunque quede una guardada", async () => {
    useMode.setState({ mode: "handy" });
    invoke.mockImplementation(async (comando: string) => (comando === "license_get_state" ? guardada : undefined));

    pintar();

    expect(await screen.findByText(/es la del TPV principal/)).toBeInTheDocument();
    expect(screen.queryByText("Caducidad")).toBeNull();
    expect(screen.queryByText("Copias de seguridad")).toBeNull();
});

it("en la Main sin licencia sigue diciendo que el equipo no tiene ninguna", async () => {
    useMode.setState({ mode: "tpv" });
    invoke.mockImplementation(async () => null);

    pintar();

    expect(await screen.findByText("Este equipo no tiene ninguna licencia activada.")).toBeInTheDocument();
    expect(screen.getByText("Copias de seguridad")).toBeInTheDocument();
});
