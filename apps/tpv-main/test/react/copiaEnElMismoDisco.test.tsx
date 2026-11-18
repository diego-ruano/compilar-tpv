/** @vitest-environment jsdom */
// REC-INC-01 · «Guardar fuera…» dice si la copia ha quedado dentro de este equipo o fuera.
//
// El diálogo deja elegir cualquier carpeta, también una del disco de los datos, otra partición u
// otro disco interno, y la pantalla decía siempre «Ya tienes un respaldo fuera de este ordenador».
// Ahora el backend dice dónde ha quedado (`donde`) y la pantalla avisa de que una copia que sigue en
// este equipo no protege de una avería.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { DondeQuedaLaCopia } from "@tpv/contracts";

import {
    AVISO_EN_ESTE_EQUIPO,
    COPIA_FUERA,
    CopiasSeguridad,
} from "../../src/features/configuracion/sections/CopiasSeguridad";
import { ToastProvider } from "../../src/shared/toast";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: async () => "D:\\copias\\copia.db.gz" }));

const COPIA = { id: "backup-1.db.gz", created_at_ms: Date.UTC(2026, 10, 1, 10), size_bytes: 2048, importada: false };

function responder(donde: DondeQuedaLaCopia) {
    invoke.mockImplementation(async (comando: string) => {
        if (comando === "recovery_list_backups") return [COPIA];
        if (comando === "recovery_export_backup") return { donde };
        throw new Error(`comando inesperado: ${comando}`);
    });
}

beforeEach(() => {
    invoke.mockReset();
});
afterEach(cleanup);

async function guardarFuera() {
    render(
        <ToastProvider>
            <CopiasSeguridad darkMode={false} />
        </ToastProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Guardar fuera…" }));
}

it("en este equipo (otra partición, otro disco interno): avisa de que no protege de una avería", async () => {
    responder("en_este_equipo");
    await guardarFuera();

    expect(await screen.findByText(AVISO_EN_ESTE_EQUIPO)).toBeInTheDocument();
    expect(screen.queryByText(/te protege si/)).toBeNull();
    expect(invoke).toHaveBeenCalledWith("recovery_export_backup", {
        backupId: COPIA.id,
        destino: "D:\\copias\\copia.db.gz",
    });
});

it("en un USB: copia guardada, sin aviso", async () => {
    responder("extraible");
    await guardarFuera();

    expect(await screen.findByText(COPIA_FUERA.extraible)).toBeInTheDocument();
    expect(screen.queryByText(AVISO_EN_ESTE_EQUIPO)).toBeNull();
});

it("en otro equipo de la red: copia guardada, sin aviso", async () => {
    responder("en_la_red");
    await guardarFuera();

    expect(await screen.findByText(COPIA_FUERA.en_la_red)).toBeInTheDocument();
    expect(screen.queryByText(AVISO_EN_ESTE_EQUIPO)).toBeNull();
});
