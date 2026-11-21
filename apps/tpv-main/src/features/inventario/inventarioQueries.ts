// Hooks de TanStack Query para **inventario** (sigue el patrón de `clientesQueries.ts`).
//
//  - Lecturas  -> useQuery con queryKey con "inventario" como prefijo.
//  - Escrituras -> useMutation que, en onSuccess, invalida la clave de la feature
//    (Local-First: el dato sólo cambia aquí, así las listas en caché se refrescan solas).
//  - Los hooks envuelven las funciones de `inventarioAPI`, con los tipos generados desde Rust.
//
// Nota: las lecturas de categorías/productos resuelven además la URL de imagen
// (resolveImageUrl) DENTRO del queryFn, de modo que la caché ya guarda las filas
// "display" listas para pintar (mismo comportamiento que tenía `useInventario`).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  AjusteLoteInput,
  AjusteStockSueltoInput,
  CreateLoteInput,
  GuardarCategoriaIngredienteInput,
  GuardarIngredienteInput,
  UpdateLoteInput,
  UpsertCategoriaInput,
  UpsertProductoInput,
} from "@tpv/contracts";

import { inventarioAPI } from "./api/inventarioAPI";
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
  catalogoIngredientes: () => ["inventario", "ingredientes"] as const,
  ingredientesDeProducto: (idProducto: string) =>
    ["inventario", "ingredientes-de-producto", idProducto] as const,
};

/** Categorías de ingredientes e ingredientes — datos de referencia, cacheados. */
export function useCatalogoIngredientes() {
  return useQuery({
    queryKey: inventarioKeys.catalogoIngredientes(),
    queryFn: () => inventarioAPI.catalogoIngredientes(),
  });
}

/** Los ids de los ingredientes que lleva un producto — cacheados por id. */
export function useIngredientesDeProducto(idProducto: string | null) {
  return useQuery({
    queryKey: inventarioKeys.ingredientesDeProducto(idProducto ?? ""),
    enabled: !!idProducto,
    queryFn: () => inventarioAPI.ingredientesDeProducto(idProducto ?? ""),
  });
}

/** Alta o renombre de una categoría de ingredientes; invalida la caché de inventario. */
export function useGuardarCategoriaIngrediente() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: GuardarCategoriaIngredienteInput) => inventarioAPI.guardarCategoriaIngrediente(args),
    onSuccess: () => qc.invalidateQueries({ queryKey: inventarioKeys.all }),
  });
}

/** Borrar una categoría de ingredientes (con sus ingredientes); invalida la caché de inventario. */
export function useBorrarCategoriaIngrediente() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => inventarioAPI.borrarCategoriaIngrediente(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: inventarioKeys.all }),
  });
}

/** Alta, renombre o cambio de categoría de un ingrediente; invalida la caché de inventario. */
export function useGuardarIngrediente() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: GuardarIngredienteInput) => inventarioAPI.guardarIngrediente(args),
    onSuccess: () => qc.invalidateQueries({ queryKey: inventarioKeys.all }),
  });
}

/** Borrar un ingrediente (y quitarlo de los productos); invalida la caché de inventario. */
export function useBorrarIngrediente() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => inventarioAPI.borrarIngrediente(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: inventarioKeys.all }),
  });
}

/** Resuelve una ruta de imagen a URL utilizable (local en Main, el worker en Handy). */
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
    mutationFn: (args: UpsertCategoriaInput) => inventarioAPI.createCategoria(args),
    onSuccess: () => qc.invalidateQueries({ queryKey: inventarioKeys.all }),
  });
}

/** Borrado de una categoría con sus productos; invalida la caché de inventario al confirmar. */
export function useBorrarCategoria() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (idCategoria: string) => inventarioAPI.borrarCategoria(idCategoria),
    onSuccess: () => qc.invalidateQueries({ queryKey: inventarioKeys.all }),
  });
}

/** Alta/edición de producto; devuelve el id y invalida la caché de inventario. */
export function useUpsertProducto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: UpsertProductoInput) => inventarioAPI.upsertProducto(args),
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
    mutationFn: (args: CreateLoteInput) => inventarioAPI.createLote(args),
    onSuccess: () => qc.invalidateQueries({ queryKey: inventarioKeys.all }),
  });
}

/** Edición de los datos de un lote (sin sus existencias, RI-55); invalida la caché de inventario. */
export function useUpdateLote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: UpdateLoteInput) => inventarioAPI.updateLote(args),
    onSuccess: () => qc.invalidateQueries({ queryKey: inventarioKeys.all }),
  });
}

/**
 * Ajuste de las existencias de un lote con lo que se vio (RI-55). Invalida la caché también si falla:
 * un rechazo por «las existencias han cambiado» significa que lo que se enseña ya no vale.
 */
export function useAjustarLote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: AjusteLoteInput) => inventarioAPI.ajustarLote(args),
    onSettled: () => qc.invalidateQueries({ queryKey: inventarioKeys.all }),
  });
}

/** Lo mismo para el stock suelto de un producto (RI-55). */
export function useAjustarStockSuelto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: AjusteStockSueltoInput) => inventarioAPI.ajustarStockSuelto(args),
    onSettled: () => qc.invalidateQueries({ queryKey: inventarioKeys.all }),
  });
}
