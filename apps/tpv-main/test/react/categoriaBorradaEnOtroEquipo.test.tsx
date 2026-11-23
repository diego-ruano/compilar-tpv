/** @vitest-environment jsdom */
// Si otro equipo borra la categoría que se tiene abierta, se deja de enseñar al releer la lista:
// con la copia vieja se podía editar y guardar, y el guardado (por id) la volvía a crear.
import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { useInventario } from "../../src/features/inventario/hooks/useInventario";

const BEBIDAS = { ID_Categoria: "beb", Nombre: "Bebidas", urlImagen: "" };
const POSTRES = { ID_Categoria: "pos", Nombre: "Postres", urlImagen: "" };

const datos = vi.hoisted(() => ({ categorias: undefined as unknown[] | undefined }));
vi.mock("../../src/features/inventario/inventarioQueries", () => ({
    useCategorias: () => ({ data: datos.categorias, refetch: vi.fn() }),
    useResumenInventario: () => ({ data: undefined, refetch: vi.fn() }),
    useProductosByCategoria: () => ({ data: [], isFetching: false, refetch: vi.fn() }),
}));

it("la categoría abierta se suelta cuando la lista releída ya no la tiene", () => {
    datos.categorias = [BEBIDAS, POSTRES];
    const { result, rerender } = renderHook(() => useInventario());
    act(() => result.current.setCategoriaSeleccionada(BEBIDAS as never));
    expect(result.current.categoriaSeleccionada?.ID_Categoria).toBe("beb");

    // Una relectura con otra lista que todavía la tiene no la suelta, y la renombrada se actualiza.
    datos.categorias = [{ ...BEBIDAS, Nombre: "Refrescos" }, POSTRES];
    rerender();
    expect(result.current.categoriaSeleccionada?.Nombre).toBe("Refrescos");

    // Borrada en otro equipo: la relectura ya no la trae.
    datos.categorias = [POSTRES];
    rerender();
    expect(result.current.categoriaSeleccionada).toBeNull();
});

it("mientras la lista no se ha leído, no suelta nada", () => {
    datos.categorias = undefined;
    const { result, rerender } = renderHook(() => useInventario());
    act(() => result.current.setCategoriaSeleccionada(BEBIDAS as never));
    rerender();
    expect(result.current.categoriaSeleccionada?.ID_Categoria).toBe("beb");
});
