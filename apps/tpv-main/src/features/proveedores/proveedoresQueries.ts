// Hooks de TanStack Query para **proveedores** (sigue el patrón de `clientesQueries.ts`).
//
// Patrón:
//  - Lecturas  -> useQuery con queryKey prefijada por el nombre de la feature.
//  - Escrituras -> useMutation que, en onSuccess, invalida la clave de la feature para
//    que las listas en caché se refresquen solas (Local-First: el dato sólo cambia aquí).
//  - El hook envuelve las funciones de `proveedoresApis.ts` (invokeClient) sin tocar su firma.
//
// Nota: `proveedoresGetProductosAll` se deja como llamada directa en el consumidor (carga
// puntual on-demand al abrir el modal de vincular, con post-proceso/preselección y re-invocación
// imperativa). No aporta cache envolverla en un hook.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  proveedoresGetAll,
  proveedoresGetCategorias,
  proveedoresGetProductos,
  proveedoresSave,
  proveedoresDelete,
  proveedoresSetVinculos,
  proveedoresCreateProducto,
} from "./proveedoresApis";

/** Prefijo de claves de la feature; invalidar esto refresca todas sus listas. */
export const proveedoresKeys = {
  all: ["proveedores"] as const,
  list: () => ["proveedores", "list"] as const,
  categorias: () => ["proveedores", "categorias"] as const,
  productos: (idProveedor: string) => ["proveedores", "productos", idProveedor] as const,
};

/** Lista de proveedores (cacheada). */
export function useProveedoresAll() {
  return useQuery({
    queryKey: proveedoresKeys.list(),
    queryFn: () => proveedoresGetAll(),
  });
}

/** Categorías disponibles (lista estable). */
export function useProveedoresCategorias() {
  return useQuery({
    queryKey: proveedoresKeys.categorias(),
    queryFn: () => proveedoresGetCategorias(),
  });
}

/** Productos vinculados a un proveedor (cacheada por id; sólo se consulta si hay id válido). */
export function useProveedoresProductos(idProveedor: string | null | undefined) {
  const id = String(idProveedor ?? "").trim();
  return useQuery({
    queryKey: proveedoresKeys.productos(id),
    queryFn: () => proveedoresGetProductos({ idProveedor: id }),
    enabled: id.length > 0,
  });
}

/** Alta/edición de proveedor; invalida la caché de proveedores si el backend confirma. */
export function useSaveProveedor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: proveedoresSave,
    onSuccess: (ok) => {
      if (ok) void qc.invalidateQueries({ queryKey: proveedoresKeys.all });
    },
  });
}

/** Eliminación de proveedor; invalida la caché de proveedores si el backend confirma. */
export function useDeleteProveedor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: proveedoresDelete,
    onSuccess: (ok) => {
      if (ok) void qc.invalidateQueries({ queryKey: proveedoresKeys.all });
    },
  });
}

/** Set de vínculos producto↔proveedor; invalida la caché de proveedores si el backend confirma. */
export function useSetVinculos() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: proveedoresSetVinculos,
    onSuccess: (ok) => {
      if (ok) void qc.invalidateQueries({ queryKey: proveedoresKeys.all });
    },
  });
}

/** Crea un producto (ya vinculado); invalida la caché de proveedores si se creó (id > 0). */
export function useCreateProducto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: proveedoresCreateProducto,
    onSuccess: (idNuevo) => {
      if (idNuevo) void qc.invalidateQueries({ queryKey: proveedoresKeys.all });
    },
  });
}
