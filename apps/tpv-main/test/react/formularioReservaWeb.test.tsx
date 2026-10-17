/** @vitest-environment jsdom */
// Reservas desde la web: el formulario de una mesa en el editor del plano.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReservaWebMesaDto } from "@tpv/contracts";
import FormularioReservaWeb from "../../src/features/mesas/editor/FormularioReservaWeb";

const api = vi.hoisted(() => ({ guardar: vi.fn() }));
vi.mock("@tpv/client", () => ({ commands: { reservaWebGuardarMesa: api.guardar }, toAppError: (e: Error) => e }));

afterEach(() => { cleanup(); vi.resetAllMocks(); });

const actual: ReservaWebMesaDto = {
    id_mesa: "m1", activa: true, dias_semana: 31, fecha_desde: null, fecha_hasta: null,
    hora_desde: "12:00", hora_hasta: "16:00",
};

/** Mientras guarda, no se cierra: si no, se podía abrir otra mesa y la respuesta de ésta la cerraba. */
it("mientras guarda no se puede cerrar, y al terminar avisa de lo guardado", async () => {
    let terminar!: () => void;
    api.guardar.mockReturnValue(new Promise<null>((ok) => { terminar = () => ok(null); }));
    const onCerrar = vi.fn();
    const onGuardada = vi.fn();
    render(<FormularioReservaWeb nombreMesa="Mesa 1" idMesa="m1" actual={actual} onCerrar={onCerrar} onGuardada={onGuardada} />);

    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "✕" }));
    expect(onCerrar).not.toHaveBeenCalled();

    await act(async () => terminar());

    expect(onGuardada).toHaveBeenCalledWith(actual);
    expect(api.guardar).toHaveBeenCalledTimes(1);
});

it("enseña lo que tenía la mesa y la frase del error si no se puede guardar", async () => {
    api.guardar.mockRejectedValue(new Error("Indica la hora de apertura y la de cierre"));
    render(<FormularioReservaWeb nombreMesa="Mesa 1" idMesa="m1" actual={actual} onCerrar={vi.fn()} onGuardada={vi.fn()} />);
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(screen.getByLabelText("Desde", { selector: "input[inputmode=numeric]" })).toHaveValue("12:00");

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Guardar" })); });

    expect(screen.getByText("Indica la hora de apertura y la de cierre")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeEnabled();
});

it("una mesa sin guardar en el plano no se puede configurar todavía", () => {
    render(<FormularioReservaWeb nombreMesa="Mesa 9" idMesa={null} actual={undefined} onCerrar={vi.fn()} onGuardada={vi.fn()} />);
    expect(screen.getByText(/Guarda el plano antes/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Guardar" })).toBeNull();
});
