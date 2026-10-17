/** @vitest-environment jsdom */
// Reservas desde la web en el editor del plano: el formulario de una mesa sólo se puede abrir con su
// configuración leída. Abrirlo sin ella enseñaba la mesa apagada, y guardarlo borraba la que tenía.
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReservaWebMesaDto } from "@tpv/contracts";
import { useMesasWeb } from "../../src/features/mesas/editor/useMesasWeb";

const api = vi.hoisted(() => ({ leer: vi.fn() }));
vi.mock("@tpv/client", () => ({ commands: { reservaWebMesas: api.leer }, toAppError: (e: Error) => e }));

afterEach(() => { cleanup(); vi.resetAllMocks(); });

const mesa = (id: string): ReservaWebMesaDto => ({
    id_mesa: id, activa: true, dias_semana: 127, fecha_desde: null, fecha_hasta: null,
    hora_desde: "12:00", hora_hasta: "16:00",
});

/** Una lectura que contesta cuando el test quiere. */
function pendiente() {
    let contestar!: (lista: ReservaWebMesaDto[]) => void;
    let fallar!: (e: Error) => void;
    const promesa = new Promise<ReservaWebMesaDto[]>((ok, ko) => { contestar = ok; fallar = ko; });
    return { promesa, contestar, fallar };
}

it("mientras no ha leído, no está lista; al leer, tiene cada mesa por su id", async () => {
    const lectura = pendiente();
    api.leer.mockReturnValue(lectura.promesa);
    const { result } = renderHook(() => useMesasWeb(true));
    expect(result.current.estado).toBe("cargando");

    await act(async () => lectura.contestar([mesa("m1")]));

    expect(result.current.estado).toBe("listo");
    expect(result.current.mesas.m1?.hora_desde).toBe("12:00");
});

it("si la lectura falla lo dice, y reintentar la vuelve a pedir", async () => {
    api.leer.mockRejectedValueOnce(new Error("Sin conexión")).mockResolvedValueOnce([mesa("m1")]);
    const { result } = renderHook(() => useMesasWeb(true));
    await waitFor(() => expect(result.current.estado).toBe("error"));
    expect(result.current.error).toBe("Sin conexión");

    await act(() => result.current.recargar());

    expect(result.current.estado).toBe("listo");
    expect(api.leer).toHaveBeenCalledTimes(2);
});

it("una respuesta vieja no pisa a la más reciente", async () => {
    const vieja = pendiente();
    const nueva = pendiente();
    api.leer.mockReturnValueOnce(vieja.promesa).mockReturnValueOnce(nueva.promesa);
    const { result } = renderHook(() => useMesasWeb(true));
    let recarga!: Promise<void>;
    act(() => { recarga = result.current.recargar(); });

    await act(async () => { nueva.contestar([mesa("nueva")]); await recarga; });
    await act(async () => vieja.contestar([mesa("vieja")]));

    expect(result.current.estado).toBe("listo");
    expect(Object.keys(result.current.mesas)).toEqual(["nueva"]);
});

it("en la Handy no pide nada", () => {
    renderHook(() => useMesasWeb(false));
    expect(api.leer).not.toHaveBeenCalled();
});
