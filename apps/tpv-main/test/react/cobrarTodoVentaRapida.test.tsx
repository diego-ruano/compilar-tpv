/** @vitest-environment jsdom */
// SYN-INC-05 · «Cobrar todo» en la venta rápida: cuándo avisa de que la cuenta ha cambiado y cuándo
// deja de cobrar todo.
//
// Mientras se cobra todo, cada recarga del ticket vuelve a seleccionar lo pendiente. Si la recarga
// viene de otro equipo (la réplica), se avisa con el total nuevo; si viene de una línea que acaba de
// añadir el propio cajero, no: avisarle de que «han añadido algo» era decirle lo que había hecho él.
// Y el estado se apaga al cancelar el cobro, al cobrar y al pasar a otro ticket, y se mantiene tras
// un cobro rechazado porque la cuenta había cambiado.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import VentaRapida from "../../src/app/pages/VentaRapida";
import { useSyncSignal } from "../../src/shared/stores/useSyncSignal";

const api = vi.hoisted(() => ({ vrBootstrap: vi.fn(), vrListProductosByCategoria: vi.fn(), vrSearchProductos: vi.fn(), vrAddLineaComanda: vi.fn(),
    vrGetLineasComanda: vi.fn(), vrRemoveLastUnpaidLinea: vi.fn(), vrListCategoriasVendibles: vi.fn(), vrDeleteLineaIfUnpaid: vi.fn(), vrUpdateNotaDetalle: vi.fn(), vrCreateComandaBarra: vi.fn() }));
const pago = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), warning: vi.fn(), success: vi.fn() }));
vi.mock("../../src/features/ventaRapida/ventaRapidaAPI", () => api);
vi.mock("../../src/features/ventaRapida/useCobrosPendientes", () => ({ useCobrosPendientes: () => ({ pendientes: [], recargar: async () => {}, main: true, error: null }) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (nombre: string, args: unknown) => nombre === "vr_cobrar_fraccionado" ? pago(args) : Promise.resolve(null) }));
vi.mock("../../src/shared/lib/usePermisos", () => ({ usePermisos: () => ({ puede: () => true }) }));
vi.mock("../../src/shared/lib/imageUrl", () => ({ resolveImageUrl: async () => "" }));
vi.mock("../../src/shared/toast", () => ({ useToast: () => toast }));
vi.mock("../../src/shared/stores/useMode", () => ({ useMode: (fn: (s: { mode: string }) => unknown) => fn({ mode: "tpv" }) }));
vi.mock("../../src/features/ventaRapida/ui/AddProductModal", () => ({ default: () => null }));
vi.mock("../../src/features/inventario/ProductDetailModal", () => ({ default: () => null }));
vi.mock("../../src/shared/ticket/PrintTicketModal", () => ({ default: () => null }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

const cat = { ID_Categoria: "bebidas", Nombre: "Bebidas", Ruta_Imagen: null };
const producto = { ID_Producto: "cafe", ID_Categoria: "bebidas", Nombre: "Café", Precio_Venta: 300, Ruta_Imagen: null };
const cafe = { ID_Detalle: "0192f7a4-3b1c-7d2e-8f00-123456789abc", ID_Producto: "cafe", Nombre: "Café", Cantidad: 1, Precio_Unitario: 300, Pagado: 0 };
const otro = { ...cafe, ID_Detalle: "0192f7a4-3b1c-7d2e-8f00-123456789abd" };
const pagado = (l: typeof cafe) => ({ ...l, Pagado: 1 });

async function abrir(lineas: unknown[]) {
    api.vrBootstrap.mockResolvedValue({ idComanda: "comanda", categorias: [cat], lineas });
    api.vrListProductosByCategoria.mockResolvedValue([producto]);
    api.vrSearchProductos.mockResolvedValue([]);
    api.vrGetLineasComanda.mockResolvedValue(lineas);
    api.vrAddLineaComanda.mockResolvedValue({ ok: true });
    render(<VentaRapida />);
    fireEvent.click(await screen.findByRole("button", { name: /Bebidas/ }));
    await screen.findByText("Café");
}

/** Lo que dice «Seleccionado» en el panel del ticket. */
const seleccionado = () => screen.getByText("Seleccionado").nextElementSibling?.textContent ?? "";

/** Un cambio de esta comanda que llega de otro equipo por la réplica. */
function cambioRemoto() {
    act(() => {
        useSyncSignal.getState().bump({ ids: ["comanda"], touchedComanda: true, uncertain: false, touchedCatalog: false }, ["detalle_comanda"]);
    });
}

const cobroConTodo = (n: number) => JSON.stringify(pago.mock.calls[n][0]).includes('"todo":true');

it("lo que añade el propio cajero mientras cobra todo entra en el cobro sin avisarle", async () => {
    await abrir([cafe]);
    fireEvent.click(screen.getByRole("button", { name: "Cobrar todo" }));
    api.vrGetLineasComanda.mockResolvedValue([cafe, otro]);
    fireEvent.click(screen.getByRole("button", { name: "Añadir uno" }));
    await waitFor(() => expect(seleccionado()).toMatch(/6,00/));
    expect(toast.warning).not.toHaveBeenCalled();

    pago.mockResolvedValue("ticket");
    fireEvent.click(screen.getByRole("button", { name: "Cobrar con tarjeta" }));
    await waitFor(() => expect(pago).toHaveBeenCalledTimes(1));
    expect(cobroConTodo(0)).toBe(true);
    expect(JSON.stringify(pago.mock.calls[0][0])).toContain(otro.ID_Detalle);
});

it("lo que añade otro equipo mientras se cobra todo entra en el cobro y se avisa", async () => {
    await abrir([cafe]);
    fireEvent.click(screen.getByRole("button", { name: "Cobrar todo" }));
    api.vrGetLineasComanda.mockResolvedValue([cafe, otro]);
    cambioRemoto();
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith("Han añadido algo a la cuenta", expect.stringMatching(/6,00/)));
    expect(seleccionado()).toMatch(/6,00/);
});

it("cancelar el cobro deja de cobrar todo: lo que llega después ni se selecciona ni se avisa", async () => {
    await abrir([cafe]);
    fireEvent.click(screen.getByRole("button", { name: "Cobrar todo" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar cobro" }));
    const lecturas = api.vrGetLineasComanda.mock.calls.length;
    api.vrGetLineasComanda.mockResolvedValue([cafe, otro]);
    cambioRemoto();
    await waitFor(() => expect(api.vrGetLineasComanda.mock.calls.length).toBeGreaterThan(lecturas));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Eliminar" })).toHaveLength(2));
    expect(toast.warning).not.toHaveBeenCalled();
    expect(seleccionado()).toMatch(/0,00/);
});

it("un cobro rechazado porque la cuenta ha cambiado sigue cobrando todo, con lo nuevo", async () => {
    await abrir([cafe]);
    fireEvent.click(screen.getByRole("button", { name: "Cobrar todo" }));
    pago.mockRejectedValueOnce({ code: "conflict", message: "La cuenta ha cambiado mientras se cobraba." });
    api.vrGetLineasComanda.mockResolvedValue([cafe, otro]);
    fireEvent.click(screen.getByRole("button", { name: "Cobrar con tarjeta" }));
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith("Han añadido algo a la cuenta", expect.stringMatching(/6,00/)));

    pago.mockResolvedValue("ticket");
    fireEvent.click(screen.getByRole("button", { name: "Cobrar con tarjeta" }));
    await waitFor(() => expect(pago).toHaveBeenCalledTimes(2));
    expect(cobroConTodo(1)).toBe(true);
    expect(JSON.stringify(pago.mock.calls[1][0])).toContain(otro.ID_Detalle);
});

it("cobrado el ticket, deja de cobrar todo: una línea que llega después no se selecciona sola", async () => {
    await abrir([cafe]);
    fireEvent.click(screen.getByRole("button", { name: "Cobrar todo" }));
    pago.mockResolvedValue("ticket");
    api.vrGetLineasComanda.mockResolvedValue([pagado(cafe)]);
    fireEvent.click(screen.getByRole("button", { name: "Cobrar con tarjeta" }));
    await waitFor(() => expect(pago).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Eliminar" })).not.toBeInTheDocument());

    api.vrGetLineasComanda.mockResolvedValue([pagado(cafe), otro]);
    cambioRemoto();
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Eliminar" })).toHaveLength(1));
    expect(toast.warning).not.toHaveBeenCalled();
    expect(seleccionado()).toMatch(/0,00/);
});

it("pasar a un ticket nuevo deja de cobrar todo: lo que se le añade no se selecciona solo", async () => {
    await abrir([cafe]);
    fireEvent.click(screen.getByRole("button", { name: "Cobrar todo" }));
    api.vrCreateComandaBarra.mockResolvedValue("comanda-2");
    fireEvent.click(screen.getByRole("button", { name: "Nuevo ticket" }));
    await waitFor(() => expect(api.vrCreateComandaBarra).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("button", { name: "Eliminar" })).not.toBeInTheDocument());

    api.vrGetLineasComanda.mockResolvedValue([otro]);
    fireEvent.click(await screen.findByRole("button", { name: /Bebidas/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Añadir uno" }));
    await waitFor(() => expect(api.vrAddLineaComanda).toHaveBeenCalledWith("comanda-2", "cafe", 1));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Eliminar" })).toHaveLength(1));
    expect(seleccionado()).toMatch(/0,00/);
});
