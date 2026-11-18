/** @vitest-environment jsdom */
// REC-INC-01 · «Guardar fuera…» dice si la copia ha quedado en el mismo disco.
//
// El diálogo deja elegir cualquier carpeta, también una del disco de los datos, y la pantalla decía
// siempre «Ya tienes un respaldo fuera de este ordenador». Ahora el backend dice dónde ha quedado
// (`mismo_disco`) y la pantalla avisa de que esa copia no protege de una avería.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { AVISO_MISMO_DISCO, CopiasSeguridad } from "../../src/features/configuracion/sections/CopiasSeguridad";
import { ToastProvider } from "../../src/shared/toast";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: async () => "C:\\Users\\bar\\Documents\\copia.db.gz" }));

const COPIA = { id: "backup-1.db.gz", created_at_ms: Date.UTC(2026, 10, 1, 10), size_bytes: 2048, importada: false };

function responder(mismoDisco: boolean) {
    invoke.mockImplementation(async (comando: string) => {
        if (comando === "recovery_list_backups") return [COPIA];
        if (comando === "recovery_export_backup") return { mismo_disco: mismoDisco };
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

it("en el mismo disco: avisa de que no protege de una avería", async () => {
    responder(true);
    await guardarFuera();

    expect(await screen.findByText(AVISO_MISMO_DISCO)).toBeInTheDocument();
    expect(screen.queryByText(/fuera de este ordenador/)).toBeNull();
    expect(invoke).toHaveBeenCalledWith("recovery_export_backup", {
        backupId: COPIA.id,
        destino: "C:\\Users\\bar\\Documents\\copia.db.gz",
    });
});

it("en otro disco: copia guardada, sin aviso", async () => {
    responder(false);
    await guardarFuera();

    expect(await screen.findByText(/Está fuera de este disco/)).toBeInTheDocument();
    expect(screen.queryByText(AVISO_MISMO_DISCO)).toBeNull();
});
