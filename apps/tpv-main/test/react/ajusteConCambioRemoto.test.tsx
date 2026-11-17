/** @vitest-environment jsdom */
// INV-MEJ-02: con el ajuste del suelto abierto (0,500 → 0,750 y su motivo), otro equipo lo ajustó a
// 0,625. El modal se volvía a montar con el dato nuevo: la propuesta y el motivo se perdían sin
// aviso. Y el ajuste del suelto mandaba como «lo visto» lo de la ficha al confirmar, no lo de al
// abrir: habría pisado el cambio del otro. Ahora el borrador se queda, se avisa, y para ajustar hay
// que partir de lo de ahora.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import AjustarExistenciasModal from "../../src/features/inventario/ui/AjustarExistenciasModal";

vi.mock("../../src/shared/toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock("../../src/shared/lib/conAviso", () => ({
    conAviso: (fn: (...a: unknown[]) => unknown) => (...a: unknown[]) => { void fn(...a); },
}));

afterEach(cleanup);

it("un cambio de otro equipo con el ajuste abierto conserva el borrador y obliga a partir de lo de ahora", async () => {
    const onConfirmar = vi.fn(async () => {});
    const props = { onClose: () => {}, titulo: "Stock suelto de Zumo", permiteDejarDeLlevar: true, onConfirmar };
    const { rerender } = render(<AjustarExistenciasModal {...props} actual={0.5} />);

    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "0.75" } });
    fireEvent.change(screen.getByPlaceholderText("Recuento, merma, rotura…"), { target: { value: "recuento" } });

    rerender(<AjustarExistenciasModal {...props} actual={0.625} />);

    expect(screen.getByRole("spinbutton")).toHaveValue(0.75);
    expect(screen.getByPlaceholderText("Recuento, merma, rotura…")).toHaveValue("recuento");
    expect(screen.getByRole("alert")).toHaveTextContent("ahora hay 0.625");
    const ajustar = screen.getByRole("button", { name: "Ajustar" });
    expect(ajustar).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Partir de lo de ahora" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(ajustar);
    await waitFor(() => expect(onConfirmar).toHaveBeenCalledWith(0.75, "recuento", 0.625));
});

it("sin cambios entre medias, manda lo que se veía al abrir", async () => {
    const onConfirmar = vi.fn(async () => {});
    render(<AjustarExistenciasModal onClose={() => {}} titulo="Lote L-1" actual={2} onConfirmar={onConfirmar} />);
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "1.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Ajustar" }));
    await waitFor(() => expect(onConfirmar).toHaveBeenCalledWith(1.5, null, 2));
});

// La causa de que se perdiera: la ficha cambiaba todo su contenido por «Cargando» en cada
// refresco de fondo, y eso desmontaba el ajuste abierto.
const ficha = vi.hoisted(() => ({
    detalle: { data: null as unknown, isFetching: false, isPending: false },
    lotes: { data: [] as unknown[], isFetching: false },
}));
vi.mock("../../src/features/inventario/inventarioQueries", () => ({
    useProductoDetalle: () => ficha.detalle,
    useLotesByProducto: () => ficha.lotes,
    useAjustarLote: () => ({ mutateAsync: vi.fn() }),
    useAjustarStockSuelto: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("../../src/shared/lib/usePermisos", () => ({ usePermisos: () => ({ puede: () => true }) }));
vi.mock("../../src/shared/lib/imageUrl", () => ({ resolveImageUrl: async () => "" }));
vi.mock("../../src/features/inventario/ui/AddLoteModal", () => ({ default: () => null }));

const { default: ProductDetailModal } = await import("../../src/features/inventario/ProductDetailModal");

it("un refresco de la ficha no desmonta el ajuste abierto", async () => {
    const zumo = (suelto: number) => ({
        ID_Producto: "zumo", Nombre: "Zumo", Precio_Venta: 330, Ruta_Imagen: null,
        Stock_Minimo: null, Stock_Suelto: suelto, Cantidad_Pedido_Esperada: null, Alergenos: [],
    });
    ficha.detalle = { data: zumo(0.5), isFetching: false, isPending: false };
    const { rerender } = render(<ProductDetailModal open productId="zumo" onClose={() => {}} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Ajustar" })[0]!);
    fireEvent.change(await screen.findByRole("spinbutton"), { target: { value: "0.75" } });

    // Llega el cambio de otro equipo: primero la relectura en curso, luego el dato nuevo.
    ficha.detalle = { data: zumo(0.5), isFetching: true, isPending: false };
    rerender(<ProductDetailModal open productId="zumo" onClose={() => {}} />);
    ficha.detalle = { data: zumo(0.625), isFetching: false, isPending: false };
    rerender(<ProductDetailModal open productId="zumo" onClose={() => {}} />);

    expect(screen.getByRole("spinbutton")).toHaveValue(0.75);
    expect(screen.getByRole("alert")).toHaveTextContent("ahora hay 0.625");
    expect(screen.queryByText(/Cargando/)).not.toBeInTheDocument();
});
