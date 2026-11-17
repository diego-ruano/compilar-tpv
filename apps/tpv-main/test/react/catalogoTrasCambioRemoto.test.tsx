/** @vitest-environment jsdom */
// INV-INC-02: con una mesa abierta, otro equipo cambió el precio y la imagen de un producto. La
// tarjeta seguía con los de antes mientras la línea se añadía con el precio nuevo: el catálogo del
// servicio no está en React Query y no se releía con la réplica. Ahora lo relee el propio hook, el
// que comparten Mesas y Venta Rápida, sin pasar por «Cargando».
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { useCatalogoServicio } from "../../src/shared/lib/useCatalogoServicio";
import { useSyncSignal } from "../../src/shared/stores/useSyncSignal";

vi.mock("../../src/shared/lib/imageUrl", () => ({ resolveImageUrl: async () => "" }));
vi.mock("../../src/shared/observability/sentry", () => ({ captureException: vi.fn() }));

type Prod = { ID_Producto: string; Precio_Venta: number; Ruta_Imagen: string | null };
const BEBIDAS = { ID_Categoria: "beb", Ruta_Imagen: null };

function montar(precio: { actual: number }) {
    const api = {
        categorias: vi.fn(async () => [BEBIDAS]),
        productos: vi.fn(async (): Promise<Prod[]> => [{ ID_Producto: "zumo", Precio_Venta: precio.actual, Ruta_Imagen: null }]),
        buscar: vi.fn(async (): Promise<Prod[]> => []),
    };
    const vista = renderHook(() => useCatalogoServicio(true, api));
    return { api, vista };
}

const cambio = (touchedCatalog: boolean) =>
    act(() => useSyncSignal.getState().bump({ ids: [], touchedComanda: false, uncertain: false, touchedCatalog }));

afterEach(() => useSyncSignal.setState({ tick: 0 }));

it("un cambio de la carta llegado por la réplica relee los productos en pantalla, sin «Cargando»", async () => {
    const precio = { actual: 330 };
    const { api, vista } = montar(precio);
    await waitFor(() => expect(vista.result.current.categorias).toHaveLength(1));
    act(() => vista.result.current.setCategoriaSeleccionada(vista.result.current.categorias[0]!));
    await waitFor(() => expect(vista.result.current.productos[0]?.Precio_Venta).toBe(330));

    precio.actual = 345;
    const cargando: boolean[] = [];
    cambio(true);
    cargando.push(vista.result.current.loadingProductos);
    await waitFor(() => expect(vista.result.current.productos[0]?.Precio_Venta).toBe(345));
    expect(cargando).toEqual([false]);
    expect(api.categorias).toHaveBeenCalledTimes(2);
});

it("un cambio que no toca la carta (sólo comandas) no relee nada", async () => {
    const { api, vista } = montar({ actual: 330 });
    await waitFor(() => expect(vista.result.current.categorias).toHaveLength(1));
    act(() => vista.result.current.setCategoriaSeleccionada(vista.result.current.categorias[0]!));
    await waitFor(() => expect(api.productos).toHaveBeenCalledTimes(1));

    cambio(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(api.productos).toHaveBeenCalledTimes(1);
    expect(api.categorias).toHaveBeenCalledTimes(1);
});
