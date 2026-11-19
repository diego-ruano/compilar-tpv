/** @vitest-environment jsdom */
// «Libre»: borrar el turno de un día de una semana con plantilla hacía volver el de la plantilla.
// El día libre es una asignación del turno LIBRE sin horas, que tapa la plantilla.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import Trabajadores from "../../src/app/pages/Trabajadores";

const LIBRE = "00000000-0000-7000-8000-000000000101";

const { marcarLibre, borrar, confirmar, semana } = vi.hoisted(() => ({
    marcarLibre: vi.fn(),
    borrar: vi.fn(),
    confirmar: vi.fn(),
    semana: { filas: [] as unknown[] },
}));
vi.mock("../../src/features/trabajadores/trabajadoresQueries", () => {
    const consulta = (data: unknown) => ({ data, isFetching: false, isError: false, error: null, refetch: vi.fn() });
    const mutacion = (mutateAsync: unknown = vi.fn()) => ({ mutateAsync, isPending: false });
    return {
        useTrabajadores: () => consulta([{ ID_Trabajador: "t1", Nombre: "Ana", Apellido: "Ruiz", Nombre_Rol: "Camarero", Estado: "Activo", Telefono: null, Puesto: null }]),
        useTurnos: () => consulta([{ ID_Turno: LIBRE, Nombre_Turno: "LIBRE" }, { ID_Turno: "m", Nombre_Turno: "MAÑANA" }]),
        useTrabajadorIdByUsuario: () => consulta(null),
        useAsignacionesSemana: () => consulta(semana.filas),
        useGuardarAsignacion: () => mutacion(),
        useDeleteAsignacion: () => mutacion(borrar),
        useCopySemanaAsignaciones: () => mutacion(),
        useSetPredeterminadoDesdeSemana: () => mutacion(),
        useMarcarLibre: () => mutacion(marcarLibre),
        useEliminarTrabajador: () => mutacion(),
    };
});
vi.mock("../../src/shared/stores/useAuth", () => ({ useAuth: () => ({ idUsuario: "u1" }) }));
vi.mock("../../src/shared/lib/usePermisos", () => ({ usePermisos: () => ({ rol: "Administrador", puede: () => true }) }));
vi.mock("../../src/shared/toast", () => ({ useToast: () => ({ info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), confirm: confirmar }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeFile: vi.fn() }));

afterEach(() => {
    cleanup();
    vi.resetAllMocks();
    vi.useRealTimers();
    semana.filas = [];
});

const pagina = () => (
    <MemoryRouter>
        <Trabajadores />
    </MemoryRouter>
);

/** El lunes de la semana que enseña la pantalla al abrirse, como `toYMD(startOfWeekMonday(new Date()))`. */
function lunesDeEstaSemana(): string {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
}

function ymd(d: Date): string {
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
}

/** Un turno de verdad (una fila, no el predeterminado) de Ana, hoy u otro día. */
const turnoDeHoy = (fecha = ymd(new Date())) => ({
    ID_Asignacion: `turno-${fecha}`,
    ID_Grupo: null,
    ID_Trabajador: "t1",
    Fecha: fecha,
    ID_Turno: "m",
    Area: "Sala",
    Hora_Inicio: "09:00",
    Hora_Fin: "14:00",
    Notas: null,
    Nombre_Turno: "MAÑANA",
    Libre: false,
});

/** El «Libre» de hoy, con una sola persona y sin turnos en los días pasados: todos lo tienen. */
const libreDeHoy = () => screen.getAllByRole("button", { name: "Libre" })[(new Date().getDay() + 6) % 7];

it("«Libre» marca el día libre del trabajador, sin preguntar si ese día no tiene turnos", async () => {
    marcarLibre.mockResolvedValue(true);
    render(pagina());
    fireEvent.click(libreDeHoy());
    await waitFor(() => expect(marcarLibre).toHaveBeenCalledWith({ id_trabajador: "t1", fecha: ymd(new Date()) }));
    expect(confirmar).not.toHaveBeenCalled();
});

it("un día que ya ha pasado se marca libre si no tuvo turnos, y si los tuvo no se ofrece", async () => {
    // Un jueves: el lunes tuvo un turno, el martes y el miércoles no.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 19, 12, 0));
    semana.filas = [turnoDeHoy("2026-11-16")];
    marcarLibre.mockResolvedValue(true);
    render(pagina());

    // Del martes al domingo: seis.
    const libres = screen.getAllByRole("button", { name: "Libre" });
    expect(libres).toHaveLength(6);
    fireEvent.click(libres[0]);
    await waitFor(() => expect(marcarLibre).toHaveBeenCalledWith({ id_trabajador: "t1", fecha: "2026-11-17" }));
    expect(confirmar).not.toHaveBeenCalled();
});

it("un día con turnos pide confirmación diciendo cuáles se quitan, y si se cancela no hace nada", async () => {
    semana.filas = [turnoDeHoy()];
    confirmar.mockResolvedValue(false);
    render(pagina());
    fireEvent.click(libreDeHoy());
    await waitFor(() => expect(confirmar).toHaveBeenCalledTimes(1));
    expect(confirmar.mock.calls[0][0]).toContain("MAÑANA 09:00-14:00");
    expect(marcarLibre).not.toHaveBeenCalled();
});

it("un día con turnos se marca libre al confirmarlo", async () => {
    semana.filas = [turnoDeHoy()];
    confirmar.mockResolvedValue(true);
    marcarLibre.mockResolvedValue(true);
    render(pagina());
    fireEvent.click(libreDeHoy());
    await waitFor(() => expect(marcarLibre).toHaveBeenCalledWith({ id_trabajador: "t1", fecha: ymd(new Date()) }));
});

it("un día libre se ve como tal, sin «Editar», y su «X» lo quita", async () => {
    borrar.mockResolvedValue(true);
    semana.filas = [
        {
            ID_Asignacion: "libre-1",
            ID_Grupo: null,
            ID_Trabajador: "t1",
            Fecha: lunesDeEstaSemana(),
            ID_Turno: LIBRE,
            Area: "Libre",
            Hora_Inicio: null,
            Hora_Fin: null,
            Notas: null,
            Nombre_Turno: "LIBRE",
            Libre: true,
        },
    ];
    render(pagina());
    const celda = screen.getByText("Día libre").closest("div.rounded-xl") as HTMLElement;
    expect(within(celda).queryByRole("button", { name: "Editar" })).toBeNull();
    fireEvent.click(within(celda).getByTitle("Quitar el día libre (vuelve el horario predeterminado)"));
    await waitFor(() => expect(borrar).toHaveBeenCalledWith("libre-1"));
});

it("el editor de turnos no ofrece LIBRE, que no lleva horas", () => {
    render(pagina());
    fireEvent.click(screen.getAllByRole("button", { name: "+ Anadir" })[0]);
    const opciones = screen.getAllByRole("option").map((o) => o.textContent);
    expect(opciones).toContain("MAÑANA");
    expect(opciones).not.toContain("LIBRE");
});
