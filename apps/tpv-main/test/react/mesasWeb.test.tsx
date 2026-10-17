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

/** Una mesa del editor ya guardada en el plano (su id de pantalla lleva el prefijo). */
const enPlano = (id: string) => ({ id: `db-mesa-${id}`, name: id, x: 0, y: 0, width: 80, height: 80, seats: 4, shape: "rect" as const });

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

/** Con el modo armado, guardar el plano vuelve a leer: mientras tanto, o si falla, no se abre nada. */
it("no abre el formulario de una mesa mientras vuelve a leer ni si la lectura falla", async () => {
    const segunda = pendiente();
    api.leer.mockResolvedValueOnce([mesa("m1")]).mockReturnValueOnce(segunda.promesa);
    const { result } = renderHook(() => useMesasWeb(true));
    await waitFor(() => expect(result.current.estado).toBe("listo"));

    let recarga!: Promise<void>;
    act(() => { recarga = result.current.recargar(); });
    let abierto = true;
    act(() => { abierto = result.current.abrir(enPlano("m1")); });
    expect(abierto).toBe(false);
    expect(result.current.abierta).toBeNull();

    await act(async () => { segunda.fallar(new Error("Sin conexión")); await recarga; });
    act(() => { abierto = result.current.abrir(enPlano("m1")); });
    expect(abierto).toBe(false);
    expect(result.current.abierta).toBeNull();
});

/** Si mientras se guardaba la mesa A se abrió la B, la respuesta de A no cierra B. */
it("al guardar sólo cierra el formulario si sigue abierto el de esa mesa", async () => {
    api.leer.mockResolvedValue([mesa("a"), mesa("b")]);
    const { result } = renderHook(() => useMesasWeb(true));
    await waitFor(() => expect(result.current.estado).toBe("listo"));

    act(() => { result.current.abrir(enPlano("a")); });
    act(() => { result.current.guardada(mesa("a")); });
    expect(result.current.abierta).toBeNull();

    act(() => { result.current.abrir(enPlano("b")); });
    act(() => { result.current.guardada({ ...mesa("a"), hora_hasta: "17:00" }); });
    expect(result.current.abierta?.id).toBe("db-mesa-b");
    expect(result.current.mesas.a?.hora_hasta).toBe("17:00");
});

it("en la Handy no pide nada", () => {
    renderHook(() => useMesasWeb(false));
    expect(api.leer).not.toHaveBeenCalled();
});
