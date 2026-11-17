/** @vitest-environment jsdom */
// INC-20261030-010: el detalle de una tarea abierta desde la lista de gestión no puede pasar a la
// vista propia, con «Marcar como finalizada», cuando a quien la mira le quitan el permiso; ni
// quedarse abierto si la tarea ya no está en su lista.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import Tareas from "../../src/app/pages/Tareas";
import { useAuth } from "../../src/shared/stores/useAuth";

const { estado, consulta, mutacion, tarea } = vi.hoisted(() => ({
    estado: { gestiona: true, admin: [] as unknown[], mias: [] as unknown[], trabajadores: [] as unknown[], asignados: [] as unknown[] },
    consulta: (data: unknown[]) => ({ data, isSuccess: true, isFetching: false, refetch: async () => ({}) }),
    mutacion: () => ({ mutateAsync: async () => true, isPending: false }),
    tarea: { ID_Tarea: "t1", Titulo: "Limpiar la barra", Descripcion: null, Fecha_Limite: null, Fecha_Creacion: "2026-10-30 10:00:00", Total_Asignados: 2, Total_Finalizadas: 0 },
}));
vi.mock("../../src/shared/lib/usePermisos", () => ({
    usePermisos: () => ({ puede: (c: string) => (c === "tareas.gestionar" ? estado.gestiona : true) }),
}));
vi.mock("../../src/features/tareas/tareasQueries", () => ({
    useTrabajadores: () => consulta(estado.trabajadores),
    useTareasAdmin: () => consulta(estado.admin),
    useMisTareas: () => consulta(estado.mias),
    usePapelera: () => consulta([]),
    useCreateTarea: mutacion, useUpdateTarea: mutacion, useSetAsignacionesTarea: mutacion,
    useDeleteTarea: mutacion, useRestaurarTarea: mutacion, useVaciarPapelera: mutacion,
    useMarcarTareaFinalizada: mutacion,
}));
vi.mock("@tpv/client", () => ({
    commands: { tareasGetTareaById: async () => tarea, tareasGetTareaAsignados: async () => estado.asignados },
}));
vi.mock("../../src/shared/lib/conAviso", () => ({ conAviso: (fn: () => unknown) => () => { void fn(); } }));

afterEach(() => {
    cleanup();
    Object.assign(estado, { gestiona: true, admin: [], mias: [], trabajadores: [], asignados: [] });
});

async function abrirComoGestor() {
    useAuth.setState({ idUsuario: "u", idTrabajador: "encargado", role: "encargado" });
    estado.admin = [tarea];
    const vista = render(<Tareas />);
    fireEvent.click(await screen.findByText("Limpiar la barra"));
    await screen.findByText(/Progreso:/);
    return vista;
}

it("al quitar el permiso de gestión con una tarea ajena abierta, el detalle se cierra", async () => {
    const { rerender } = await abrirComoGestor();
    estado.gestiona = false;
    rerender(<Tareas />);
    await waitFor(() => expect(screen.queryByText(/Progreso:/)).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Marcar como finalizada" })).not.toBeInTheDocument();
});

it("si la tarea desaparece de la lista (la borró otro equipo), el detalle se cierra", async () => {
    const { rerender } = await abrirComoGestor();
    estado.admin = [];
    rerender(<Tareas />);
    await waitFor(() => expect(screen.queryByText(/Progreso:/)).not.toBeInTheDocument());
});

// TAR-INC-02: quitar la única asignación dejaba la tarea fuera de todas las listas.
it("una tarea sin asignados sale en Pendientes y no se guarda sin nadie", async () => {
    useAuth.setState({ idUsuario: "u", idTrabajador: "encargado", role: "encargado" });
    estado.trabajadores = [{ ID_Trabajador: "ana", ID_Usuario: "u1", Nombre: "Ana", Apellido: null, Puesto: "Sala", Email: "" }];
    estado.admin = [{ ...tarea, Total_Asignados: 0, Total_Finalizadas: 0 }];
    render(<Tareas />);
    expect(await screen.findByText("Sin asignar")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Limpiar la barra"));
    await screen.findByText(/Progreso:/);
    const guardar = screen.getByRole("button", { name: "Guardar cambios" });
    expect(guardar).toBeDisabled();
    expect(screen.getByText("Asigna la tarea a alguien.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox"));
    expect(guardar).toBeEnabled();
});
