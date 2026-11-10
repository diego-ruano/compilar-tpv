/** @vitest-environment jsdom */
// AUD-19: la nube purga los cambios de más de 7 días, y una copia más antigua puede no poder
// reconciliarse con lo que queda. La pantalla de recuperación lo avisa antes de elegirla, junto a la
// antigüedad de cada copia, sin impedir usarla: si la nube aún lo guarda todo, la copia vale.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import RecuperarDatos from "../../src/app/pages/RecuperarDatos";
import { useEstadoSync } from "../../src/shared/stores/useEstadoSync";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../../src/app/layoutComponent/Titlebar", () => ({ default: () => null }));

const DIA = 24 * 60 * 60 * 1000;
const AVISO = /Tiene más de 7 días: puede que la nube ya no guarde todo lo que pasó después/;

const inicial = useEstadoSync.getState();
afterEach(() => {
    cleanup();
    useEstadoSync.setState(inicial, true);
});

it("enseña la antigüedad de cada copia y avisa, sin impedirla, de la que pasa de 7 días", async () => {
    const ahora = Date.now();
    const copia = (id: string, antes: number, importada = false) => ({
        id,
        created_at_ms: ahora - antes,
        size_bytes: 1024,
        importada,
    });
    invoke.mockImplementation(async (comando: string) =>
        comando === "recovery_list_backups"
            ? [
                  copia("data-1.db.gz", 2 * DIA + 60_000),
                  // Le falta un minuto para los 7 días: todavía no avisa.
                  copia("data-2.db.gz", 7 * DIA - 60_000),
                  copia("data-3.db.gz", 9 * DIA),
                  copia("import-4.db.gz", 30 * DIA, true),
              ]
            : undefined,
    );

    render(<RecuperarDatos />);

    const reciente = await screen.findByRole("button", { name: /^Última copia: .*\(hace 2 días\)$/ });
    const casiSiete = screen.getByRole("button", { name: /^Copia: .*\(hace 6 días\)$/ });
    const vieja = screen.getByRole("button", { name: /^Copia: .*\(hace 9 días\)$/ });
    const importada = screen.getByRole("button", { name: /^Copia importada: .*\(hace 30 días\)$/ });

    // El aviso va junto a cada copia que pasa de 7 días, y a ninguna otra.
    expect(screen.getAllByText(AVISO)).toHaveLength(2);
    expect(vieja.parentElement).toHaveTextContent(AVISO);
    expect(importada.parentElement).toHaveTextContent(AVISO);
    expect(reciente.parentElement).not.toHaveTextContent(AVISO);
    expect(casiSiete.parentElement).not.toHaveTextContent(AVISO);

    // Avisar no es bloquear: todas se pueden elegir, y la nube sigue ahí.
    for (const boton of [reciente, casiSiete, vieja, importada]) expect(boton).toBeEnabled();
    expect(screen.getByRole("button", { name: "Recuperar el estado actual de la nube" })).toBeEnabled();
});

it("una copia anterior al log acaba ofreciendo la nube, con el motivo a la vista", async () => {
    // Lo que publica el motor tras cinco ciclos fallidos con esa copia (`replicacion.rs::arrancar`).
    useEstadoSync.setState({
        reconciliacionPendiente: true,
        faseRecuperacion: "bloqueada",
        errorRecuperacion: "Esta copia es anterior a lo que guarda la nube: recupera el estado actual de la nube.",
    });
    invoke.mockImplementation(async (comando: string) => (comando === "recovery_list_backups" ? [] : undefined));

    render(<RecuperarDatos />);

    expect(await screen.findByText("La recuperación no ha podido completarse")).toBeInTheDocument();
    expect(screen.getByText(/Esta copia es anterior a lo que guarda la nube/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Recuperar el estado actual de la nube" })).toBeEnabled();
});
