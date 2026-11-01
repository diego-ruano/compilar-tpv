/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import KitchenBoard from "../../src/features/mesas/KitchenBoard";
import { useSyncSignal } from "../../src/shared/stores/useSyncSignal";

const api = vi.hoisted(() => ({ leer: vi.fn(), marcar: vi.fn() }));
vi.mock("@tpv/client", () => ({ commands: { kitchenListTodayPending: api.leer }, toAppError: (e: Error) => e }));
vi.mock("../../src/features/mesas/mesasApi", () => ({ cocinaSetLineaEstado: api.marcar }));
vi.mock("../../src/shared/lib/conAviso", () => ({ conAviso: (fn: () => Promise<void>) => () => { void fn().catch(() => {}); } }));

afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
const fila = { ID_Detalle: "detalle", ID_Comanda: "comanda", Numero_Mesa: "1", Fecha_Hora_Apertura: "2026-10-09T09:00:00",
    Cantidad: 1, Nombre_Producto: "Tostada", Notas: null, Estado_Cocina: "PENDIENTE", Pagado: 0 };
async function abrir() {
    api.leer.mockResolvedValue([fila]);
    vi.stubGlobal("scrollTo", vi.fn());
    render(<KitchenBoard idUsuarioCocinero="cocinero" />);
    return screen.findByRole("button", { name: /Tostada/ });
}

it("espera confirmación antes de ocultar una comanda y evita dos pulsaciones", async () => {
    let confirmar!: () => void;
    api.marcar.mockImplementation(() => new Promise(resolve => { confirmar = () => resolve(undefined); }));
    const linea = await abrir();
    fireEvent.click(linea); fireEvent.click(linea);
    expect(api.marcar).toHaveBeenCalledTimes(1);
    expect(linea).toBeDisabled();
    expect(screen.getByText("1× Tostada")).toBeInTheDocument();
    confirmar();
    await waitFor(() => expect(screen.queryByText("1× Tostada")).not.toBeInTheDocument());
});

it("la comanda lleva el nombre de la mesa, sin otro «Mesa» delante", async () => {
    api.leer.mockResolvedValue([fila, { ...fila, ID_Detalle: "d2", ID_Comanda: "otra", Numero_Mesa: "Mesa 2" }]);
    vi.stubGlobal("scrollTo", vi.fn());
    render(<KitchenBoard idUsuarioCocinero="cocinero" />);
    expect(await screen.findByText("Mesa 1 · Comanda #comanda")).toBeInTheDocument();
    expect(screen.getByText("Mesa 2 · Comanda #otra")).toBeInTheDocument();
});

it("un fallo conserva la comanda pendiente y permite reintentar", async () => {
    api.marcar.mockRejectedValue(new Error("Sin conexión"));
    const linea = await abrir();
    fireEvent.click(linea);
    expect(await screen.findByRole("alert")).toHaveTextContent("Sin conexión");
    expect(linea).toBeEnabled();
    expect(screen.getByText("1× Tostada")).toBeInTheDocument();
});

// INC-20261030-006: lo que cambia en otro equipo llega por la señal de sincronización. Antes la
// cocina sólo escuchaba `vr:changed`, que es de esta ventana, y se quedaba vacía o con estados
// viejos hasta pulsar Recargar.
const otraLinea = { ...fila, ID_Detalle: "d2", Nombre_Producto: "Cafe" };
const cambioEnComanda = { ids: ["comanda"], touchedComanda: true, uncertain: false, touchedCatalog: false };

afterEach(() => { useSyncSignal.setState({ tick: 0 }); });

it("una línea añadida en otro equipo aparece sin pulsar Recargar y sin quitar la lista", async () => {
    await abrir();
    api.leer.mockResolvedValue([fila, otraLinea]);
    act(() => useSyncSignal.getState().bump(cambioEnComanda));
    expect(screen.queryByText("Cargando…")).not.toBeInTheDocument();
    expect(await screen.findByText("1× Cafe")).toBeInTheDocument();
    expect(screen.getByText("1× Tostada")).toBeInTheDocument();
});

it("un cambio que no toca comandas no vuelve a leer", async () => {
    await abrir();
    act(() => useSyncSignal.getState().bump({ ids: [], touchedComanda: false, uncertain: false, touchedCatalog: true }));
    await Promise.resolve();
    expect(api.leer).toHaveBeenCalledTimes(1);
});

it("un cambio remoto mientras se marca una línea se lee al terminar la marca", async () => {
    let confirmar!: () => void;
    api.marcar.mockImplementation(() => new Promise(resolve => { confirmar = () => resolve(undefined); }));
    const linea = await abrir();
    fireEvent.click(linea);
    api.leer.mockResolvedValue([fila, otraLinea]);
    act(() => useSyncSignal.getState().bump(cambioEnComanda));
    expect(api.leer).toHaveBeenCalledTimes(1);
    confirmar();
    expect(await screen.findByText("1× Cafe")).toBeInTheDocument();
    expect(api.leer).toHaveBeenCalledTimes(2);
});

// INC-20261030-021: desde `lg` la página de Mesas no se desplaza (es para el plano), así que la lista
// de la cocina tiene que hacerlo dentro; si no, lo que no cabe queda recortado y la rueda no llega.
it("la lista de comandas se desplaza dentro de la cocina", async () => {
    const linea = await abrir();
    expect(linea.closest(".overflow-y-auto")).not.toBeNull();
});
