/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import VentaRapida from "../../src/app/pages/VentaRapida";
const api = vi.hoisted(() => ({ vrBootstrap: vi.fn(), vrListProductosByCategoria: vi.fn(), vrSearchProductos: vi.fn(), vrAddLineaComanda: vi.fn(),
    vrGetLineasComanda: vi.fn(), vrRemoveLastUnpaidLinea: vi.fn(), vrListCategoriasVendibles: vi.fn(), vrDeleteLineaIfUnpaid: vi.fn(), vrUpdateNotaDetalle: vi.fn(), vrCreateComandaBarra: vi.fn() }));
const pago = vi.hoisted(() => vi.fn());
vi.mock("../../src/features/ventaRapida/ventaRapidaAPI", () => api);
vi.mock("../../src/features/ventaRapida/useCobrosPendientes", () => ({ useCobrosPendientes: () => ({ pendientes: [], recargar: async () => {}, main: true, error: null }) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (nombre: string, args: unknown) => nombre === "vr_cobrar_fraccionado" ? pago(args) : Promise.resolve(null) }));
vi.mock("../../src/shared/lib/usePermisos", () => ({ usePermisos: () => ({ puede: () => true }) }));
vi.mock("../../src/shared/lib/imageUrl", () => ({ resolveImageUrl: async () => "" }));
vi.mock("../../src/shared/toast", () => ({ useToast: () => ({ error: vi.fn(), info: vi.fn() }) }));
vi.mock("../../src/shared/stores/useMode", () => ({ useMode: (fn: (s: { mode: string }) => unknown) => fn({ mode: "tpv" }) }));
vi.mock("../../src/features/ventaRapida/ui/AddProductModal", () => ({ default: () => null }));
vi.mock("../../src/features/inventario/ProductDetailModal", () => ({ default: () => null }));
vi.mock("../../src/shared/ticket/PrintTicketModal", () => ({ default: () => null }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const cat = { ID_Categoria: "bebidas", Nombre: "Bebidas", Ruta_Imagen: null };
const producto = { ID_Producto: "cafe", ID_Categoria: "bebidas", Nombre: "Café", Precio_Venta: 300, Ruta_Imagen: null };
const fila = { ID_Detalle: "0192f7a4-3b1c-7d2e-8f00-123456789abc", ID_Producto: "cafe", Nombre: "Café", Cantidad: 1, Precio_Unitario: 300, Pagado: 0 };
async function abrir(lineas: unknown[] = []) {
    api.vrBootstrap.mockResolvedValue({ idComanda: "comanda", categorias: [cat], lineas });
    api.vrListProductosByCategoria.mockResolvedValue([producto]);
    api.vrSearchProductos.mockResolvedValue([]);
    api.vrGetLineasComanda.mockResolvedValue(lineas);
    render(<VentaRapida />);
    fireEvent.click(await screen.findByRole("button", { name: /Bebidas/ }));
    await screen.findByText("Café");
}
it("mantiene el ticket confirmado hasta que terminan dos adiciones rápidas", async () => {
    let responder!: () => void;
    api.vrAddLineaComanda.mockImplementationOnce(() => new Promise(resolve => { responder = () => resolve({ ok: true }); }));
    api.vrAddLineaComanda.mockResolvedValueOnce({ ok: true });
    await abrir();
    // abrir configura la lectura inicial; las siguientes lecturas son respuestas autoritativas.
    api.vrGetLineasComanda.mockResolvedValueOnce([fila]).mockResolvedValueOnce([fila, { ...fila, ID_Detalle: "otro" }]);
    const mas = screen.getByRole("button", { name: "Añadir uno" });
    fireEvent.click(mas); fireEvent.click(mas);
    await waitFor(() => expect(api.vrAddLineaComanda).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: "Eliminar" })).not.toBeInTheDocument();
    responder();
    await waitFor(() => expect(api.vrAddLineaComanda).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Eliminar" })).toHaveLength(2));
});
it("no marca como pagado ni envía dos cobros antes de la respuesta", async () => {
    let responder!: () => void;
    pago.mockImplementationOnce(() => new Promise(resolve => { responder = () => resolve("ticket"); }));
    await abrir([fila]);
    fireEvent.click(screen.getByRole("button", { name: "Cobrar todo" }));
    const tarjeta = await screen.findByRole("button", { name: /tarjeta/i });
    fireEvent.click(tarjeta); fireEvent.click(tarjeta);
    await waitFor(() => expect(pago).toHaveBeenCalledTimes(1));
    expect(tarjeta).toBeDisabled();
    expect(screen.getByRole("button", { name: "Eliminar" })).toBeInTheDocument();
    api.vrGetLineasComanda.mockResolvedValue([{ ...fila, Pagado: 1 }]);
    responder();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Eliminar" })).not.toBeInTheDocument());
});

// INC-20261030-016: un ticket cobrado entero ya no admite líneas, y tras cobrar se queda a la vista.
// Lo que se añade entonces es otra venta: va a un ticket nuevo, no al cobrado.
it("lo que se añade con el ticket ya cobrado va a un ticket nuevo", async () => {
    await abrir([{ ...fila, Pagado: 1 }]);
    api.vrCreateComandaBarra.mockResolvedValueOnce("nueva");
    api.vrAddLineaComanda.mockResolvedValueOnce({ ok: true });
    api.vrGetLineasComanda.mockImplementation(async (id: string) => id === "nueva" ? [{ ...fila, ID_Detalle: "nuevo" }] : [{ ...fila, Pagado: 1 }]);
    fireEvent.click(screen.getByRole("button", { name: "Añadir uno" }));
    await waitFor(() => expect(api.vrAddLineaComanda).toHaveBeenCalledTimes(1));
    expect(api.vrCreateComandaBarra).toHaveBeenCalledTimes(1);
    expect(api.vrAddLineaComanda.mock.calls[0][0]).toBe("nueva");
    await waitFor(() => expect(screen.getByRole("button", { name: "Eliminar" })).toBeInTheDocument());
});

it("con líneas pendientes, lo que se añade sigue en el mismo ticket", async () => {
    await abrir([fila]);
    api.vrAddLineaComanda.mockResolvedValueOnce({ ok: true });
    fireEvent.click(screen.getByRole("button", { name: "Añadir uno" }));
    await waitFor(() => expect(api.vrAddLineaComanda).toHaveBeenCalledTimes(1));
    expect(api.vrCreateComandaBarra).not.toHaveBeenCalled();
    expect(api.vrAddLineaComanda.mock.calls[0][0]).toBe("comanda");
});
