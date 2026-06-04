// Hooks de TanStack Query para **clientes** (FEATURE DE REFERENCIA del patrón).
//
// Patrón a seguir en el resto de features:
//  - Lecturas  -> useQuery con queryKey con el nombre de la feature como prefijo.
//  - Escrituras -> useMutation que, en onSuccess, invalida la clave de la feature para
//    que las listas en caché se refresquen solas (Local-First: el dato sólo cambia aquí).
//  - El hook envuelve las funciones de `*Apis.ts` (invokeClient) sin tocar su firma.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  clientesCreateCliente,
  clientesGetOverview,
  clientesUpdateCliente,
  type FiltroRanking,
} from "./clientesApis";

/** Prefijo de claves de la feature; invalidar esto refresca todas sus listas. */
export const clientesKeys = {
  all: ["clientes"] as const,
  overview: (ranking: FiltroRanking) => ["clientes", "overview", ranking] as const,
};

/** Lista/overview de clientes según el ranking seleccionado (cacheada por ranking). */
export function useClientesOverview(ranking: FiltroRanking) {
  return useQuery({
    queryKey: clientesKeys.overview(ranking),
    queryFn: () => clientesGetOverview({ ranking }),
  });
}

/** Alta de cliente; invalida la caché de clientes si el backend confirma el cambio. */
export function useCreateCliente() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: clientesCreateCliente,
    onSuccess: (ok) => {
      if (ok) qc.invalidateQueries({ queryKey: clientesKeys.all });
    },
  });
}

/** Edición de cliente; invalida la caché de clientes si el backend confirma el cambio. */
export function useUpdateCliente() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: clientesUpdateCliente,
    onSuccess: (ok) => {
      if (ok) qc.invalidateQueries({ queryKey: clientesKeys.all });
    },
  });
}
