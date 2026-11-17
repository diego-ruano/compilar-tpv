/** @vitest-environment jsdom */
// INC-20261030-010: el detalle de una tarea abierta desde la lista de gestión no puede pasar a la
// vista propia, con «Marcar como finalizada», cuando a quien la mira le quitan el permiso; ni
// quedarse abierto si la tarea ya no está en su lista.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Tareas from "../../src/app/pages/Tareas";
import { useAuth } from "../../src/shared/stores/useAuth";

const { estado, consulta, mutacion, tarea, finalizar } = vi.hoisted(() => ({
    finalizar: vi.fn(async (_: unknown) => true),
    estado: { gestiona: true, propias: true, admin: [] as unknown[], mias: [] as unknown[], trabajadores: [] as unknown[], asignados: [] as unknown[] },
    consulta: (data: unknown[]) => ({ data, isSuccess: true, isFetching: false, refetch: async () => ({}) }),
    mutacion: () => ({ mutateAsync: async () => true, isPending: false }),
    tarea: { ID_Tarea: "t1", Titulo: "Limpiar la barra", Descripcion: null, Fecha_Limite: null, Fecha_Creacion: "2026-10-30 10:00:00", Total_Asignados: 2, Total_Finalizadas: 0 },
}));
vi.mock("../../src/shared/lib/usePermisos", () => ({
    usePermisos: () => ({
        puede: (c: string) => (c === "tareas.gestionar" ? estado.gestiona : c === "tareas.propias" ? estado.propias : true),
    }),
}));
vi.mock("../../src/features/tareas/tareasQueries", () => ({
    useTrabajadores: () => consulta(estado.trabajadores),
    useTareasAdmin: () => consulta(estado.admin),
    useMisTareas: () => consulta(estado.mias),
    usePapelera: () => consulta([]),
    useCreateTarea: mutacion, useUpdateTarea: mutacion, useSetAsignacionesTarea: mutacion,
    useDeleteTarea: mutacion, useRestaurarTarea: mutacion, useVaciarPapelera: mutacion,
    useMarcarTareaFinalizada: () => ({ mutateAsync: finalizar, isPending: false }),
}));
vi.mock("@tpv/client", () => ({
    commands: { tareasGetTareaById: async () => tarea, tareasGetTareaAsignados: async () => estado.asignados },
}));
vi.mock("../../src/shared/lib/conAviso", () => ({ conAviso: (fn: () => unknown) => () => { void fn(); } }));

afterEach(() => {
    cleanup();
    finalizar.mockClear();
    Object.assign(estado, { gestiona: true, propias: true, admin: [], mias: [], trabajadores: [], asignados: [] });
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

// TAR-INC-03: el Encargado, con los dos permisos, abre sus tareas en el detalle de gestión, que no
// tenía cómo acabar la suya.
describe("quien gestiona y tiene la suya pendiente", () => {
    const asignacion = (ID_Trabajador: string, Estado: string) => ({
        ID_Trabajador, Nombre: ID_Trabajador, Apellido: null, Puesto: null,
        Asignada_At: "2026-10-30 10:00:00", Estado, Finalizada_At: null,
    });

    it("puede marcar la suya como finalizada desde el detalle de gestión", async () => {
        estado.asignados = [asignacion("encargado", "PENDIENTE"), asignacion("ana", "PENDIENTE")];
        await abrirComoGestor();
        fireEvent.click(await screen.findByRole("button", { name: "Marcar la mía como finalizada" }));
        await waitFor(() => expect(finalizar).toHaveBeenCalledWith({ id_tarea: "t1", id_trabajador: "encargado" }));
    });

    it.each([
        ["sin el permiso de las suyas", () => { estado.propias = false; estado.asignados = [asignacion("encargado", "PENDIENTE")]; }],
        ["si la suya ya está finalizada", () => { estado.asignados = [asignacion("encargado", "FINALIZADA")]; }],
        ["si no es suya", () => { estado.asignados = [asignacion("ana", "PENDIENTE")]; }],
    ])("no aparece %s", async (_, preparar) => {
        preparar();
        await abrirComoGestor();
        await screen.findAllByText(/Asignada:/);
        expect(screen.queryByRole("button", { name: "Marcar la mía como finalizada" })).not.toBeInTheDocument();
    });
});

// TAR-MEJ-01: una tarea con el límite pasado se veía igual que las demás en la lista.
it("una pendiente con el límite pasado lleva «Vencida»; la de más adelante, la acabada o sin límite, no", async () => {
    useAuth.setState({ idUsuario: "u", idTrabajador: "encargado", role: "encargado" });
    estado.admin = [
        { ...tarea, ID_Tarea: "a", Titulo: "Pasada", Fecha_Limite: "2020-01-01" },
        { ...tarea, ID_Tarea: "b", Titulo: "Lejana", Fecha_Limite: "2999-12-31" },
        { ...tarea, ID_Tarea: "c", Titulo: "Sin límite", Fecha_Limite: null },
        { ...tarea, ID_Tarea: "d", Titulo: "Acabada", Fecha_Limite: "2020-01-01", Total_Finalizadas: 2 },
    ];
    render(<Tareas />);
    await screen.findByText("Pasada");
    expect(screen.getAllByText("Vencida")).toHaveLength(1);
    expect(screen.getByText("Pasada").closest("button")).toHaveTextContent("Vencida");
});
