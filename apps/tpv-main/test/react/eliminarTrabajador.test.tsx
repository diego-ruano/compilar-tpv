/** @vitest-environment jsdom */
// «Dar de baja» era un marcador («Por implementar»). «Eliminar» pide confirmación diciendo qué pasa,
// y lo que haya pasado (borrado o retirado) lo dice el backend.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import EliminarTrabajadorModal from "../../src/features/trabajadores/EliminarTrabajadorModal";

const { invoke, exito } = vi.hoisted(() => ({ invoke: vi.fn(), exito: vi.fn() }));
vi.mock("@tauri-apps/api/core", async (original) => ({ ...(await original<object>()), invoke }));
vi.mock("../../src/shared/toast", () => ({
    useToast: () => ({ info: vi.fn(), error: vi.fn(), success: exito, warning: vi.fn() }),
}));

afterEach(() => {
    cleanup();
    vi.resetAllMocks();
});

const PEPE = {
    ID_Trabajador: "t-pepe",
    ID_Usuario: "u-pepe",
    Nombre: "Pepe",
    Apellido: "Ruiz",
    Email: "pepe@bar.test",
    Estado: "Activo",
    Nombre_Rol: "Camarero",
    Telefono: null,
    Puesto: null,
};

function pintar(onCerrar = vi.fn()) {
    render(
        <QueryClientProvider client={new QueryClient()}>
            <EliminarTrabajadorModal trabajador={PEPE as any} onCerrar={onCerrar} />
        </QueryClientProvider>,
    );
    return onCerrar;
}

it("dice qué pasa antes de eliminar, y que con historia se ha retirado", async () => {
    invoke.mockResolvedValue({ retirado: true });
    const onCerrar = pintar();

    await screen.findByText("Eliminar a Pepe Ruiz");
    expect(screen.getByText(/todo eso se conserva a su nombre/)).toBeInTheDocument();
    expect(screen.getByText(/mejor desactívalo desde «Editar»/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Eliminar" }));
    await waitFor(() => expect(onCerrar).toHaveBeenCalled());
    expect(invoke).toHaveBeenCalledWith("trabajadores_eliminar", { args: { id_trabajador: "t-pepe" } });
    expect(exito).toHaveBeenCalledWith("Trabajador retirado", expect.stringContaining("se conservan"));
});

it("si el backend lo rechaza, el modal se queda abierto con el motivo", async () => {
    invoke.mockRejectedValue({
        code: "conflict",
        message: "No se puede dejar el negocio sin ningún administrador activo. Da antes el rol de Administrador a otra persona.",
    });
    const onCerrar = pintar();

    fireEvent.click(await screen.findByRole("button", { name: "Eliminar" }));
    await screen.findByText(/sin ningún administrador activo/);
    expect(onCerrar).not.toHaveBeenCalled();
});

it("la lista ofrece «Eliminar» y ya no el «Dar de baja» de mentira", () => {
    const fuente = readFileSync(resolve(__dirname, "../../src/app/pages/Trabajadores.tsx"), "utf8");
    expect(fuente).not.toMatch(/Dar de baja|Por implementar/);
    expect(fuente).toMatch(/<EliminarTrabajadorModal\b/);
});
