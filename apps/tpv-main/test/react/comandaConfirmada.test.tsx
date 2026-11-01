/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import MesaComandaModal from "../../src/features/mesas/MesaComandaModal";
import { useAuth } from "../../src/shared/stores/useAuth";

const api = vi.hoisted(() => ({
    mesasEnsureOpenComanda: vi.fn(), mesasLoadTicket: vi.fn(), mesasAddDetalle: vi.fn(),
    mesasCobrarDetalles: vi.fn(), productosListCategoriasVendibles: vi.fn(), productosListByCategoria: vi.fn(),
    productosSearchByNombre: vi.fn(), mesasRemoveOnePendingDetalle: vi.fn(), mesasDeleteDetalle: vi.fn(),
    mesasUpdateDetalleNota: vi.fn(), reservaMarcarActivaAhora: vi.fn(), reservaFinalizar: vi.fn(), mesasLoadMesaMeta: vi.fn(),
    mesasComandaAbierta: vi.fn(), mesasComandaSetReservaIfNull: vi.fn(),
}));
vi.mock("../../src/features/mesas/mesasApi", () => api);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (comando: string) => {
    if (comando === "list_categorias_vendibles") return api.productosListCategoriasVendibles();
    throw new Error(`Comando inesperado en la prueba: ${comando}`);
} }));
vi.mock("../../src/shared/lib/imageUrl", () => ({ resolveImageUrl: async () => "" }));
vi.mock("../../src/shared/lib/conAviso", () => ({ conAviso: (fn: unknown) => fn }));
vi.mock("../../src/shared/stores/useMode", () => ({ useMode: (fn: (s: { mode: string }) => unknown) => fn({ mode: "tpv" }) }));
vi.mock("../../src/shared/stores/useBusinessSettings", () => ({ useBusinessSettings: (fn: (s: { limite_simplif: number }) => unknown) => fn({ limite_simplif: 300000 }) }));
vi.mock("../../src/shared/toast", () => ({ useToast: () => ({ error: vi.fn(), warning: vi.fn(), info: vi.fn() }) }));
vi.mock("../../src/features/inventario/ProductDetailModal", () => ({ default: () => null }));
vi.mock("../../src/shared/ticket/PrintTicketModal", () => ({ default: () => null }));
vi.mock("../../src/shared/ticket/DatosFiscalesModal", () => ({ default: () => null }));
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

// INC-20261030-016: la comanda y la reserva del modal se fijaban al abrir. Si otro equipo cobraba
// la comanda y abría la siguiente, o cerraba la reserva, esta pantalla no se enteraba, y lo que se
// añadía iba a la comanda ya cobrada, donde nadie lo iba a cobrar.
const pagada = (id: string) => ({ ...fila(id), Pagado: 1 });
const meta = (idComanda: string, reserva?: unknown) => ({
    mesa: { ocupada: true, id_comanda: idComanda, idComanda, totalPendiente: 0, pendientesPago: 0, pendientesCocina: 0, estado: "", reserva },
});
async function abrirCon(qc: QueryClient, mesaMeta?: unknown) {
    useAuth.setState({ idUsuario: "operador", idTrabajador: "trabajador", role: "camarero" });
    api.productosListCategoriasVendibles.mockResolvedValue([categoria]);
    api.productosListByCategoria.mockResolvedValue([producto]);
    render(<QueryClientProvider client={qc}><MesaComandaModal open onClose={() => {}} mesaId="mesa" mesaNombre="1" mesaMeta={mesaMeta as any} /></QueryClientProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Bebidas" }));
    await screen.findByText("Café");
}

it("lo que se pide después de cobrarlo todo va a la comanda abierta de la mesa, no a la cobrada", async () => {
    // Cobrada entera, en pantalla es un ticket vacío: lo sabe el backend, que rechaza la línea.
    api.mesasEnsureOpenComanda.mockResolvedValueOnce("cobrada").mockResolvedValueOnce("nueva");
    api.mesasLoadTicket.mockResolvedValue([pagada("1")]);
    api.mesasLoadMesaMeta.mockResolvedValue({});
    api.mesasAddDetalle
        .mockRejectedValueOnce({ code: "conflict", message: "Esa cuenta ya está cobrada." })
        .mockResolvedValueOnce([fila("2")]);
    await abrirCon(new QueryClient());
    fireEvent.click(screen.getByRole("button", { name: "+" }));
    await waitFor(() => expect(api.mesasAddDetalle).toHaveBeenCalledTimes(2));
    expect(api.mesasAddDetalle.mock.calls[0][0].idComanda).toBe("cobrada");
    expect(api.mesasAddDetalle.mock.calls[1][0].idComanda).toBe("nueva");
    expect(api.mesasEnsureOpenComanda).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByText("Total pendiente:").textContent).toContain("3,00"));
});

it("pasa a la comanda que otro equipo abrió en la mesa después de cobrar la de esta pantalla", async () => {
    const qc = new QueryClient();
    api.mesasEnsureOpenComanda.mockResolvedValue("cobrada");
    api.mesasLoadTicket.mockImplementation(async (id: string) => id === "otra" ? [fila("3")] : [pagada("1")]);
    api.mesasLoadMesaMeta.mockResolvedValue(meta("cobrada"));
    await abrirCon(qc);
    api.mesasLoadMesaMeta.mockResolvedValue(meta("otra"));
    await qc.invalidateQueries({ queryKey: ["mesas"] });
    await waitFor(() => expect(screen.getByText("Total pendiente:").textContent).toContain("3,00"));
    expect(api.mesasLoadTicket).toHaveBeenCalledWith("otra");
});

it("una reserva que otro equipo cierra deja de verse sin cerrar el modal", async () => {
    const qc = new QueryClient();
    const reserva = { idReserva: "r", clienteNombre: "Ana", diaYMD: "2026-10-31", hora: "10:00", estado: "ACTIVA", minutosPara: 0 };
    api.mesasEnsureOpenComanda.mockResolvedValue("comanda");
    api.mesasLoadTicket.mockResolvedValue([]);
    api.mesasLoadMesaMeta.mockResolvedValue(meta("comanda", reserva));
    await abrirCon(qc, meta("comanda", reserva).mesa);
    expect(screen.getByText("🔵 Reserva activa")).toBeInTheDocument();
    api.mesasLoadMesaMeta.mockResolvedValue(meta("comanda"));
    await qc.invalidateQueries({ queryKey: ["mesas"] });
    await waitFor(() => expect(screen.queryByText("🔵 Reserva activa")).not.toBeInTheDocument());
});

// INC-20261030-007: si se abrió la mesa con la reserva todavía «Próxima», su comanda nació sin
// reserva y lo cobrado no contaba en el gasto del cliente. Al marcar la llegada se enlaza, pero si
// ya tiene productos pueden ser de los clientes anteriores: se pregunta.
const proxima = { idReserva: "r", clienteNombre: "Ana", diaYMD: "2026-10-31", hora: "21:00", estado: "PROXIMA", minutosPara: 0 };
async function llegarCon(lineas: unknown[]) {
    api.mesasEnsureOpenComanda.mockResolvedValue("comanda");
    api.mesasLoadTicket.mockResolvedValue(lineas);
    api.mesasLoadMesaMeta.mockResolvedValue(meta("comanda", proxima));
    api.mesasComandaAbierta.mockResolvedValue({ id_comanda: "comanda", id_reserva: null });
    api.reservaMarcarActivaAhora.mockResolvedValue(undefined);
    api.mesasComandaSetReservaIfNull.mockResolvedValue(true);
    await abrirCon(new QueryClient(), meta("comanda", proxima).mesa);
    fireEvent.click(screen.getByRole("button", { name: /Ha llegado ya el cliente/ }));
}

it("al llegar la reserva con la cuenta ya empezada, pregunta y la enlaza si es suya", async () => {
    await llegarCon([fila("1")]);
    fireEvent.click(await screen.findByRole("button", { name: "Sí, es suya" }));
    await waitFor(() => expect(api.mesasComandaSetReservaIfNull).toHaveBeenCalledWith("comanda", "r"));
    expect(screen.queryByText("Esta mesa tiene una cuenta abierta")).not.toBeInTheDocument();
});

it("si la cuenta es de los clientes anteriores, no se enlaza", async () => {
    await llegarCon([fila("1")]);
    fireEvent.click(await screen.findByRole("button", { name: "No, es de los anteriores" }));
    await waitFor(() => expect(screen.queryByText("Esta mesa tiene una cuenta abierta")).not.toBeInTheDocument());
    await waitFor(() => expect(api.mesasEnsureOpenComanda).toHaveBeenCalledTimes(2));
    expect(api.mesasComandaSetReservaIfNull).not.toHaveBeenCalled();
});

it("con la cuenta vacía, la enlaza sin preguntar", async () => {
    await llegarCon([]);
    await waitFor(() => expect(api.mesasComandaSetReservaIfNull).toHaveBeenCalledWith("comanda", "r"));
    expect(screen.queryByText("Esta mesa tiene una cuenta abierta")).not.toBeInTheDocument();
});
