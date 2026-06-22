// Hooks de TanStack Query para **inventario** (sigue el patrón de `clientesQueries.ts`).
//
//  - Lecturas  -> useQuery con queryKey con "inventario" como prefijo.
//  - Escrituras -> useMutation que, en onSuccess, invalida la clave de la feature
//    (Local-First: el dato sólo cambia aquí, así las listas en caché se refrescan solas).
//  - Los hooks envuelven las funciones de `inventarioAPI` sin tocar su firma.
//
// Nota: las lecturas de categorías/productos resuelven además la URL de imagen
// (resolveImageUrl) DENTRO del queryFn, de modo que la caché ya guarda las filas
// "display" listas para pintar (mismo comportamiento que tenía `useInventario`).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  inventarioAPI,
  type AjusteLoteArgs,
  type CreateCategoriaArgs,
  type CreateLoteArgs,
  type UpsertProductoArgs,
} from "./api/inventarioAPI";
import { resolveImageUrl } from "../../shared/lib/imageUrl";
import type { CategoriaDisplay, ProductoDisplay } from "./hooks/useInventario";

/** Prefijo de claves de la feature; invalidar esto refresca todas sus listas. */
export const inventarioKeys = {
  all: ["inventario"] as const,
  categorias: () => ["inventario", "categorias"] as const,
  productosByCategoria: (idCategoria: string) =>
    ["inventario", "productos", idCategoria] as const,
  resumen: () => ["inventario", "resumen"] as const,
  productoDetalle: (idProducto: string) =>
    ["inventario", "producto-detalle", idProducto] as const,
  lotes: (idProducto: string) => ["inventario", "lotes", idProducto] as const,
  proveedoresMini: () => ["inventario", "proveedores-mini"] as const,
  alergenos: () => ["inventario", "alergenos"] as const,
};

/** Resuelve una ruta de imagen a URL utilizable (local en Main, CDN en Handy). */
const resolverUrlImagen = resolveImageUrl;

/** Categorías "display" (con urlImagen ya resuelta) — cacheadas. */
export function useCategorias() {
  return useQuery({
    queryKey: inventarioKeys.categorias(),
    queryFn: async (): Promise<CategoriaDisplay[]> => {
      const rows = await inventarioAPI.listCategorias();
      return Promise.all(
        (rows ?? [])
          .filter((c) => c.ID_Categoria.length > 0)
          .map(async (cat) => {
            const urlImagen = await resolverUrlImagen(cat.Ruta_Imagen);
            return { ...cat, urlImagen };
          }),
      );
    },
  });
}

/**
 * Productos "display" (con urlImagen ya resuelta) de una categoría — cacheados.
 * Sólo se ejecuta cuando hay categoría seleccionada (idCategoria > 0).
 */
export function useProductosByCategoria(idCategoria: string | null) {
  return useQuery({
    queryKey: inventarioKeys.productosByCategoria(idCategoria ?? ""),
    enabled: !!idCategoria,
    queryFn: async (): Promise<ProductoDisplay[]> => {
      const rows = await inventarioAPI.listProductosByCategoria(idCategoria ?? "");
      return Promise.all(
        (rows ?? [])
          .filter((p) => p.ID_Producto.length > 0)
          .map(async (p) => {
            const urlImagen = await resolverUrlImagen(p.Ruta_Imagen);
            return { ...p, urlImagen };
          }),
      );
    },
  });
}

/** Resumen de inventario (próximos a caducar / menos cantidad) — cacheado. */
export function useResumenInventario() {
  return useQuery({
    queryKey: inventarioKeys.resumen(),
    queryFn: () => inventarioAPI.getResumen(),
  });
}

/** Detalle de un producto (con alérgenos) — cacheado por id. */
export function useProductoDetalle(idProducto: string | null) {
  return useQuery({
    queryKey: inventarioKeys.productoDetalle(idProducto ?? ""),
    enabled: !!idProducto,
    queryFn: () => inventarioAPI.getProductoDetalle(idProducto ?? ""),
  });
}

/** Lotes de un producto — cacheados por id. */
export function useLotesByProducto(idProducto: string | null) {
  return useQuery({
    queryKey: inventarioKeys.lotes(idProducto ?? ""),
    enabled: !!idProducto,
    queryFn: () => inventarioAPI.listLotesByProducto(idProducto ?? ""),
  });
}

/** Proveedores (mini) — datos de referencia para formularios, cacheados. */
export function useProveedoresMini() {
  return useQuery({
    queryKey: inventarioKeys.proveedoresMini(),
    queryFn: () => inventarioAPI.listProveedoresMini(),
  });
}

/** Alérgenos — datos de referencia para formularios, cacheados. */
export function useAlergenos() {
  return useQuery({
    queryKey: inventarioKeys.alergenos(),
    queryFn: () => inventarioAPI.listAlergenos(),
  });
}

/** Alta de categoría; invalida la caché de inventario al confirmar. */
export function useCreateCategoria() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: CreateCategoriaArgs) => inventarioAPI.createCategoria(args),
    onSuccess: () => qc.invalidateQueries({ queryKey: inventarioKeys.all }),
  });
}

/** Alta/edición de producto; devuelve el id y invalida la caché de inventario. */
export function useUpsertProducto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: UpsertProductoArgs) => inventarioAPI.upsertProducto(args),
    onSuccess: () => qc.invalidateQueries({ queryKey: inventarioKeys.all }),
  });
}

/** Borrado de producto; invalida la caché de inventario al confirmar. */
export function useDeleteProducto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (idProducto: string) => inventarioAPI.deleteProducto(idProducto),
    onSuccess: () => qc.invalidateQueries({ queryKey: inventarioKeys.all }),
  });
}

/** Alta de lote; invalida la caché de inventario al confirmar. */
export function useCreateLote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: CreateLoteArgs) => inventarioAPI.createLote(args),
    onSuccess: () => qc.invalidateQueries({ queryKey: inventarioKeys.all }),
  });
}

/** Ajuste de stock de un lote; invalida la caché de inventario al confirmar. */
export function useAjustarLote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: AjusteLoteArgs) => inventarioAPI.ajustarLote(args),
    onSuccess: () => qc.invalidateQueries({ queryKey: inventarioKeys.all }),
  });
}
