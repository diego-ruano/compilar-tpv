/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import MesaComandaModal from "../../src/features/mesasComponents/MesaComandaModal";
import { useAuth } from "../../src/shared/stores/useAuth";

const api = vi.hoisted(() => ({
    mesasEnsureOpenComanda: vi.fn(), mesasLoadTicket: vi.fn(), mesasAddDetalle: vi.fn(),
    mesasCobrarDetalles: vi.fn(), productosListCategoriasVendibles: vi.fn(), productosListByCategoria: vi.fn(),
    productosSearchByNombre: vi.fn(), mesasRemoveOnePendingDetalle: vi.fn(), mesasDeleteDetalle: vi.fn(),
    mesasUpdateDetalleNota: vi.fn(), reservaMarcarActivaAhora: vi.fn(), reservaFinalizar: vi.fn(),
}));
vi.mock("../../src/features/mesasComponents/mesasApi", () => api);
vi.mock("../../src/shared/lib/imageUrl", () => ({ resolveImageUrl: async () => "" }));
vi.mock("../../src/shared/lib/conAviso", () => ({ conAviso: (fn: unknown) => fn }));
vi.mock("../../src/shared/stores/useMode", () => ({ useMode: (fn: (s: { mode: string }) => unknown) => fn({ mode: "tpv" }) }));
vi.mock("../../src/shared/stores/useBusinessSettings", () => ({ useBusinessSettings: (fn: (s: { limiteSimplif: number }) => unknown) => fn({ limiteSimplif: 300000 }) }));
vi.mock("../../src/shared/toast", () => ({ useToast: () => ({ error: vi.fn(), warning: vi.fn() }) }));
vi.mock("../../src/features/InventaryComponents/ProductDetailModal", () => ({ default: () => null }));
vi.mock("../../src/shared/ticket/PrintTicketModal", () => ({ default: () => null }));
vi.mock("../../src/shared/ticket/DatosFiscalesModal", () => ({ default: () => null }));
vi.mock("../../src/shared/ticket/AvisoFiscalModal", () => ({ anunciarCobro: () => {} }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const producto = { ID_Producto: "cafe", Nombre: "Café", Precio_Venta: 300, Ruta_Imagen: null };
const categoria = { ID_Categoria: "bebidas", Nombre: "Bebidas", Ruta_Imagen: null };
const fila = (id: string) => ({ ID_Detalle: id, ID_Producto: "cafe", Nombre: "Café", Precio_Unitario: 300, Pagado: 0, Pasa_Cocina: 0, Estado_Cocina: null, Notas: null, IVA_Percent: null });
async function abrir() {
    useAuth.setState({ idUsuario: "operador", idTrabajador: "trabajador", role: "camarero" });
    api.mesasEnsureOpenComanda.mockResolvedValue("comanda");
    api.mesasLoadTicket.mockResolvedValue([]);
    api.productosListCategoriasVendibles.mockResolvedValue([categoria]);
    api.productosListByCategoria.mockResolvedValue([producto]);
    render(<QueryClientProvider client={new QueryClient()}><MesaComandaModal open onClose={() => {}} mesaId="mesa" mesaNombre="1" /></QueryClientProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Bebidas" }));
    await screen.findByText("Café");
}

it("no pinta líneas sin confirmar y conserva dos adiciones rápidas en orden", async () => {
    let responder!: (filas: ReturnType<typeof fila>[]) => void;
    api.mesasAddDetalle.mockImplementationOnce(() => new Promise(resolve => { responder = resolve; }));
    api.mesasAddDetalle.mockResolvedValueOnce([fila("1"), fila("2")]);
    await abrir();
    const mas = screen.getByRole("button", { name: "+" });
    fireEvent.click(mas);
    fireEvent.click(mas);
    await waitFor(() => expect(api.mesasAddDetalle).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Total pendiente:").textContent).toContain("0,00");
    responder([fila("1")]);
    await waitFor(() => expect(api.mesasAddDetalle).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText("Total pendiente:").textContent).toContain("6,00"));
    expect(screen.getByRole("button", { name: "Cobrar todo" })).toBeEnabled();
});

it("descarta los productos de una categoría abandonada aunque respondan al final", async () => {
    await abrir();
    fireEvent.click(screen.getByRole("button", { name: "Ver categorías" }));
    let responder!: (productos: typeof producto[]) => void;
    api.productosListByCategoria.mockImplementationOnce(() => new Promise(resolve => { responder = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Bebidas" }));
    await waitFor(() => expect(api.productosListByCategoria).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Ver categorías" }));
    api.productosListByCategoria.mockResolvedValueOnce([{ ...producto, Nombre: "Nuevo café" }]);
    fireEvent.click(screen.getByRole("button", { name: "Bebidas" }));
    await screen.findByText("Nuevo café");
    responder([{ ...producto, Nombre: "Café antiguo" }]);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(screen.queryByText("Café antiguo")).not.toBeInTheDocument();
    expect(screen.getByText("Nuevo café")).toBeInTheDocument();
});

it("envía un solo cobro al pulsar dos veces antes de que el backend responda", async () => {
    let responder!: (id: string) => void;
    api.mesasAddDetalle.mockResolvedValueOnce([fila("detalle")]);
    api.mesasCobrarDetalles.mockImplementationOnce(() => new Promise(resolve => { responder = resolve; }));
    await abrir();
    fireEvent.click(screen.getByRole("button", { name: "+" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Cobrar todo" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Cobrar todo" }));
    const tarjeta = screen.getByRole("button", { name: "Cobrar con tarjeta" });
    fireEvent.click(tarjeta);
    fireEvent.click(tarjeta);
    expect(api.mesasCobrarDetalles).toHaveBeenCalledTimes(1);
    expect(tarjeta).toBeDisabled();
    responder("pago");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cobrar con tarjeta" })).not.toBeInTheDocument());
});
