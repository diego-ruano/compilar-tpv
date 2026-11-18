/** @vitest-environment jsdom */
// Quitarle a alguien el permiso de horarios con el editor abierto: al guardar no pasaba nada, sin
// decir por qué (`if (!isAdmin) return;`). Ahora el editor se cierra y lo dice.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import Trabajadores from "../../src/app/pages/Trabajadores";

const { guardar, permiso, aviso } = vi.hoisted(() => ({
    guardar: vi.fn(),
    permiso: { horarios: true },
    aviso: vi.fn(),
}));
vi.mock("../../src/features/trabajadores/trabajadoresQueries", () => {
    const consulta = (data: unknown) => ({ data, isFetching: false, isError: false, error: null, refetch: vi.fn() });
    const mutacion = (mutateAsync: unknown = vi.fn()) => ({ mutateAsync, isPending: false });
    return {
        useTrabajadores: () => consulta([{ ID_Trabajador: "t1", Nombre: "Ana", Apellido: "Ruiz", Nombre_Rol: "Camarero", Estado: "Activo", Telefono: null, Puesto: null }]),
        useTurnos: () => consulta([{ ID_Turno: "m", Nombre_Turno: "MAÑANA" }]),
        useTrabajadorIdByUsuario: () => consulta(null),
        useAsignacionesSemana: () => consulta([]),
        useGuardarAsignacion: () => mutacion(guardar),
        useDeleteAsignacion: () => mutacion(),
        useCopySemanaAsignaciones: () => mutacion(),
        useSetPredeterminadoDesdeSemana: () => mutacion(),
        useEliminarTrabajador: () => mutacion(),
    };
});
vi.mock("../../src/shared/stores/useAuth", () => ({ useAuth: () => ({ idUsuario: "u1" }) }));
vi.mock("../../src/shared/lib/usePermisos", () => ({
    usePermisos: () => ({
        rol: "Encargado",
        puede: (c: string) => c !== "horarios.gestionar" || permiso.horarios,
    }),
}));
vi.mock("../../src/shared/toast", () => ({
    useToast: () => ({ info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: aviso }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), confirm: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeFile: vi.fn() }));

afterEach(() => {
    cleanup();
    vi.resetAllMocks();
    permiso.horarios = true;
});

const pagina = () => (
    <MemoryRouter>
        <Trabajadores />
    </MemoryRouter>
);

it("si quitan el permiso con el editor abierto, se cierra y dice por qué", async () => {
    const { rerender } = render(pagina());
    fireEvent.click(screen.getAllByRole("button", { name: "+ Anadir" })[0]);
    expect(screen.getByRole("button", { name: "Guardar" })).toBeInTheDocument();

    // Llega el cambio de permisos (la relectura de `usePermisos`).
    permiso.horarios = false;
    rerender(pagina());

    await waitFor(() => expect(screen.queryByRole("button", { name: "Guardar" })).toBeNull());
    expect(aviso).toHaveBeenCalledWith("Ya no puedes gestionar horarios", expect.any(String));
    expect(guardar).not.toHaveBeenCalled();
});
