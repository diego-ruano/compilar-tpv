/** @vitest-environment jsdom */
// RI-77: la Handy enseña la pantalla de Licencia, pero con lo que le toca a ella: la licencia es la
// del TPV principal. Lo que quede guardado de cuando el equipo fue Main no es la licencia de ahora.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Licencia } from "../../src/features/configuracion/sections/Licencia";
import { useMode } from "../../src/shared/stores/useMode";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const guardada = { status: "active", expires_at_ms: Date.now() + 90 * 86_400_000 };

beforeEach(() => invoke.mockReset());
afterEach(cleanup);

it("en la Handy explica que la licencia es de la Main, aunque quede una guardada", async () => {
    useMode.setState({ mode: "handy" });
    invoke.mockImplementation(async (comando: string) => (comando === "license_get_state" ? guardada : undefined));

    render(<Licencia darkMode={false} />);

    expect(await screen.findByText(/es la del TPV principal/)).toBeInTheDocument();
    expect(screen.queryByText("Caducidad")).toBeNull();
});

it("en la Main sin licencia sigue diciendo que el equipo no tiene ninguna", async () => {
    useMode.setState({ mode: "tpv" });
    invoke.mockImplementation(async () => null);

    render(<Licencia darkMode={false} />);

    expect(await screen.findByText("Este equipo no tiene ninguna licencia activada.")).toBeInTheDocument();
});
