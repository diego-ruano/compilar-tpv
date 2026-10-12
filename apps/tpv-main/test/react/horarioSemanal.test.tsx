/** @vitest-environment jsdom */
import { fireEvent, render, screen, cleanup, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import Trabajadores from "../../src/app/pages/Trabajadores";
import { alEscribirHora, completarHora, esHora } from "../../src/shared/ui/CampoHora";

const guardar = vi.hoisted(() => vi.fn());
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
    };
});
vi.mock("../../src/shared/stores/useAuth", () => ({ useAuth: () => ({ idUsuario: "u1" }) }));
vi.mock("../../src/shared/lib/usePermisos", () => ({ usePermisos: () => ({ rol: "Administrador", puede: () => true }) }));
vi.mock("../../src/shared/toast", () => ({ useToast: () => ({ info: vi.fn(), error: vi.fn(), success: vi.fn() }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), confirm: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeFile: vi.fn() }));

afterEach(() => { cleanup(); vi.resetAllMocks(); });

// El control nativo `type="time"` enseñaba «12:30» y «23:30» y aun así el formulario decía que
// faltaban las horas: su valor queda vacío mientras la webview no dé por completos sus segmentos.
it("las horas que se ven son las que se guardan, y el aviso de un intento anterior no se queda", async () => {
    guardar.mockResolvedValue(true);
    render(<MemoryRouter><Trabajadores /></MemoryRouter>);
    fireEvent.click(screen.getAllByRole("button", { name: "+ Anadir" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(screen.getAllByText("Debes indicar hora inicio y hora fin.").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    fireEvent.click(screen.getAllByRole("button", { name: "+ Anadir" })[0]);
    expect(screen.queryByText("Debes indicar hora inicio y hora fin.")).toBeNull();

    const inicio = screen.getByLabelText<HTMLInputElement>("Hora inicio (tramo 1)");
    const fin = screen.getByLabelText<HTMLInputElement>("Hora fin (tramo 1)");
    fireEvent.change(inicio, { target: { value: "1230" } });
    fireEvent.change(fin, { target: { value: "9:30" } });
    fireEvent.blur(fin);
    expect(inicio.value).toBe("12:30");
    expect(fin.value).toBe("09:30");
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(guardar).toHaveBeenCalledTimes(1));
    expect(guardar.mock.calls[0][0].tramos).toEqual([{ hora_inicio: "12:30", hora_fin: "09:30" }]);
});

it("una hora que no existe no llega al comando", () => {
    render(<MemoryRouter><Trabajadores /></MemoryRouter>);
    fireEvent.click(screen.getAllByRole("button", { name: "+ Anadir" })[0]);
    fireEvent.change(screen.getByLabelText("Hora inicio (tramo 1)"), { target: { value: "2560" } });
    fireEvent.change(screen.getByLabelText("Hora fin (tramo 1)"), { target: { value: "23:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(screen.getAllByText("Hora invalida (usa HH:mm).").length).toBeGreaterThan(0);
    expect(guardar).not.toHaveBeenCalled();
});

it("el campo de hora pone los dos puntos y no deja pasar más que una hora", () => {
    expect(["1", "12", "123", "1230", "12305", "9:3", "9:30", "ab1c2", "12:", "1:2:3"].map(alEscribirHora))
        .toEqual(["1", "12", "12:3", "12:30", "12:30", "9:3", "9:30", "12", "12:", "1:23"]);
    expect(["9:30", "09:30", "9:3", ""].map(completarHora)).toEqual(["09:30", "09:30", "9:3", ""]);
    expect(["00:00", "23:59", "24:00", "12:60", "9:30", "1230", ""].map(esHora))
        .toEqual([true, true, false, false, false, false, false]);
});
