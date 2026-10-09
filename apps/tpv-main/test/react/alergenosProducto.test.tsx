/** @vitest-environment jsdom */
// RI-22: los UUID deben servir tanto para los iconos como para guardar la selección de la ficha.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AddProductModal } from "../../src/features/inventario/ui/AddProductModal";
import { deCentimos } from "../../src/shared/lib/dinero";

const datos = vi.hoisted(() => ({
    leer: vi.fn(), guardar: vi.fn(),
    toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() },
    alergenos: [
        { ID_Alergeno: "00000000-0000-7000-8000-000000000201", Nombre: "Gluten", Nombre_Imagen: "gluten.png", Ruta_Imagen: "/alergenos/gluten.png" },
        { ID_Alergeno: "00000000-0000-7000-8000-000000000202", Nombre: "Crustáceos", Nombre_Imagen: "crustaceos.png", Ruta_Imagen: "/alergenos/crustaceos.png" },
    ],
    categorias: [{ ID_Categoria: "categoria-1", Nombre: "Comida" }],
    proveedores: [],
}));

vi.mock("../../src/features/inventario/api/inventarioAPI", () => ({ inventarioAPI: { getProductoDetalle: datos.leer } }));
vi.mock("../../src/features/inventario/inventarioQueries", () => ({
    useAlergenos: () => ({ data: datos.alergenos }),
    useCategorias: () => ({ data: datos.categorias }),
    useProveedoresMini: () => ({ data: datos.proveedores }),
    useUpsertProducto: () => ({ mutateAsync: datos.guardar }),
    useCreateLote: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("../../src/shared/lib/imageUrl", () => ({
    resolveImageUrl: async (ruta: string) => `https://imagenes.test${ruta}`,
    triggerImageUploadDrain: vi.fn(),
}));
vi.mock("../../src/shared/lib/usePermisos", () => ({ usePermisos: () => ({ puede: () => true }) }));
vi.mock("../../src/shared/toast", () => ({ useToast: () => datos.toast }));

beforeEach(() => {
    datos.leer.mockResolvedValue({
        ID_Producto: "producto-1", ID_Categoria: "categoria-1", ID_Proveedor: null,
        Nombre: "Sopa", Precio_Venta: deCentimos(600), Stock_Suelto: 0,
        Nombre_Imagen: null, Ruta_Imagen: null, alergs: [datos.alergenos[0]],
    });
    datos.guardar.mockResolvedValue("producto-1");
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("muestra iconos con UUID, guarda las altas y bajas y recupera la selección", async () => {
    const props = { open: true, onClose: vi.fn(), onSaved: vi.fn(), categoriaPreseleccionadaId: null, productIdToEdit: "producto-1" };
    const primera = render(<AddProductModal {...props} />);
    const gluten = await screen.findByRole("button", { name: "Alergeno Gluten" });
    await waitFor(() => expect(gluten).toHaveAttribute("aria-pressed", "true"));
    await waitFor(() => expect(screen.getByAltText("Gluten")).toHaveAttribute("src", "https://imagenes.test/alergenos/gluten.png"));
    expect(screen.getByAltText("Crustáceos")).toHaveAttribute("src", "https://imagenes.test/alergenos/crustaceos.png");

    fireEvent.click(gluten);
    fireEvent.click(screen.getByRole("button", { name: "Alergeno Crustáceos" }));
    await waitFor(() => {
        expect(gluten).toHaveAttribute("aria-pressed", "false");
        expect(screen.getByRole("button", { name: "Alergeno Crustáceos" })).toHaveAttribute("aria-pressed", "true");
    });
    fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
    await waitFor(() => expect(datos.guardar).toHaveBeenCalledOnce());
    expect(datos.guardar.mock.calls[0][0].ids_alergenos).toEqual([datos.alergenos[1].ID_Alergeno]);
    await waitFor(() => expect(props.onSaved).toHaveBeenCalledOnce());

    const ficha = await datos.leer.mock.results[0].value;
    datos.leer.mockResolvedValue({ ...ficha, alergs: [datos.alergenos[1]] });
    primera.unmount();
    render(<AddProductModal {...props} />);
    await waitFor(() => {
        expect(screen.getByRole("button", { name: "Alergeno Gluten" })).toHaveAttribute("aria-pressed", "false");
        expect(screen.getByRole("button", { name: "Alergeno Crustáceos" })).toHaveAttribute("aria-pressed", "true");
    });
});
