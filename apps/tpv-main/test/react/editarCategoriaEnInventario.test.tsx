/** @vitest-environment jsdom */
// En Inventario, «Editar categoría» abre su modal; desde él se pide eliminarla y la confirmación
// sale encima. Cancelar vuelve a la edición; confirmar cierra las dos y vuelve a la lista.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import Inventario from "../../src/app/pages/Inventario";

const datos = vi.hoisted(() => ({
    seleccionar: vi.fn(),
    borrar: { mutateAsync: vi.fn(async (_id: string) => {}), isPending: false },
}));

vi.mock("../../src/features/inventario/hooks/useInventario", () => ({
    useInventario: () => ({
        categorias: [],
        categoriaSeleccionada: {
            ID_Categoria: "beb", Nombre: "Bebidas", Nombre_Imagen: null, Ruta_Imagen: null,
            Vendible: 1, Pasa_Cocina: 0, urlImagen: "",
        },
        productos: [],
        loadingProductos: false,
        proximosCaducar: [],
        menosCantidad: [],
        titulo: "INVENTARIO · Bebidas",
        setCategoriaSeleccionada: datos.seleccionar,
        cargarCategorias: async () => {},
        cargarProductos: async () => {},
        cargarResumenInventario: async () => {},
    }),
}));
vi.mock("../../src/features/inventario/inventarioQueries", () => ({
    useDeleteProducto: () => ({ mutateAsync: vi.fn() }),
    useCreateCategoria: () => ({ mutateAsync: vi.fn() }),
    useBorrarCategoria: () => datos.borrar,
}));
vi.mock("../../src/shared/lib/usePermisos", () => ({ usePermisos: () => ({ puede: () => true }) }));
vi.mock("../../src/shared/toast", () => ({ useToast: () => ({ error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() }) }));
vi.mock("../../src/shared/lib/imageUrl", () => ({ triggerImageUploadDrain: vi.fn() }));
vi.mock("../../src/shared/lib/guardarImagen", () => ({ guardarImagen: vi.fn() }));
vi.mock("@tpv/client", () => ({
    commands: { imagesDelete: vi.fn() },
    toAppError: (e: unknown) => ({ code: "internal", message: String(e) }),
}));
vi.mock("../../src/features/inventario/ui/ProductsSection", () => ({ default: () => null }));
vi.mock("../../src/features/inventario/ui/CategoriesSection", () => ({ default: () => null }));
vi.mock("../../src/features/inventario/ui/SummarySection", () => ({ default: () => null }));
vi.mock("../../src/features/inventario/ui/IngredientesModal", () => ({ default: () => null }));
vi.mock("../../src/features/inventario/ui/AddProductModal", () => ({ AddProductModal: () => null }));
vi.mock("../../src/features/inventario/ProductDetailModal", () => ({ default: () => null }));

afterEach(() => {
    cleanup();
    datos.seleccionar.mockClear();
    datos.borrar.mutateAsync.mockClear();
});

const titulo = (nombre: string) => screen.queryByRole("heading", { name: nombre });

it("la cabecera ya no borra: edita, y desde la edición se elimina", async () => {
    render(<Inventario />);
    expect(titulo("Editar categoría")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Editar categoría" }));
    expect(titulo("Editar categoría")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Bebidas")).toBeInTheDocument();

    // La confirmación sale encima de la edición (después en el documento, con el mismo z-index).
    fireEvent.click(screen.getByRole("button", { name: "Eliminar categoría" }));
    const confirmacion = titulo("Eliminar categoría")!;
    expect(confirmacion).toBeInTheDocument();
    expect(titulo("Editar categoría")!.compareDocumentPosition(confirmacion) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Cancelar la confirmación vuelve a la edición.
    const cancelar = screen.getAllByRole("button", { name: "Cancelar" });
    fireEvent.click(cancelar[cancelar.length - 1]);
    expect(titulo("Eliminar categoría")).not.toBeInTheDocument();
    expect(titulo("Editar categoría")).toBeInTheDocument();
    expect(datos.borrar.mutateAsync).not.toHaveBeenCalled();

    // Confirmar la borra, cierra las dos y vuelve a la lista.
    fireEvent.click(screen.getByRole("button", { name: "Eliminar categoría" }));
    fireEvent.click(screen.getByRole("button", { name: "Eliminar" }));
    await waitFor(() => expect(datos.seleccionar).toHaveBeenCalledWith(null));
    expect(datos.borrar.mutateAsync).toHaveBeenCalledWith("beb");
    expect(titulo("Eliminar categoría")).not.toBeInTheDocument();
    expect(titulo("Editar categoría")).not.toBeInTheDocument();
});
