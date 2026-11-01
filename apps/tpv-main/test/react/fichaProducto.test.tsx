/** @vitest-environment jsdom */
// INC-20261030-018: desde Mesas y la venta rápida la ficha del producto enseñaba «Editar» y
// «Eliminar producto» sin que nadie supiera hacerlo: «Editar» no abría nada, y «Eliminar» pedía
// confirmación y cerraba la ficha como si lo hubiera borrado. Sólo salen si quien abre la ficha
// los atiende (Inventario, Proveedores).
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import ProductDetailModal from "../../src/features/inventario/ProductDetailModal";

const { producto } = vi.hoisted(() => ({
    producto: {
        ID_Producto: "p1", ID_Categoria: "c1", Nombre: "Croquetas", Precio_Venta: 750, Stock_Suelto: null,
        Stock_Minimo: null, Unidad_Medida: null, Nombre_Imagen: null, Ruta_Imagen: null, alergs: [],
    },
}));
vi.mock("../../src/features/inventario/inventarioQueries", () => ({
    useProductoDetalle: () => ({ data: producto, isFetching: false, isError: false, error: null }),
    useLotesByProducto: () => ({ data: [], isFetching: false, isError: false, error: null, refetch: async () => ({}) }),
    useAjustarLote: () => ({ mutateAsync: async () => {} }),
    useAjustarStockSuelto: () => ({ mutateAsync: async () => {} }),
}));
vi.mock("../../src/shared/lib/usePermisos", () => ({ usePermisos: () => ({ puede: () => true }) }));
vi.mock("../../src/shared/lib/imageUrl", () => ({ resolveImageUrl: async () => "" }));
vi.mock("../../src/shared/toast", () => ({ useToast: () => ({ error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() }) }));
vi.mock("../../src/features/inventario/ui/AddLoteModal", () => ({ default: () => null }));
vi.mock("../../src/features/inventario/ui/AjustarExistenciasModal", () => ({ default: () => null }));

afterEach(() => cleanup());

it("abierta desde Mesas o la venta rápida, no ofrece editar ni eliminar", async () => {
    render(<ProductDetailModal open onClose={() => {}} productId="p1" />);
    expect((await screen.findAllByRole("button", { name: /Añadir lote/ })).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /Editar/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Eliminar producto/ })).not.toBeInTheDocument();
});

it("abierta desde Inventario, sí", async () => {
    render(<ProductDetailModal open onClose={() => {}} productId="p1" onEdit={() => {}} onDeleted={() => {}} />);
    expect(await screen.findByRole("button", { name: /Editar/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Eliminar producto/ })).toBeInTheDocument();
});
