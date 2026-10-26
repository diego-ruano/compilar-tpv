import { commands } from "@tpv/client";
// Hooks de TanStack Query para **clientes** (FEATURE DE REFERENCIA del patrón).
//
// Patrón a seguir en el resto de features:
//  - Lecturas  -> useQuery con queryKey con el nombre de la feature como prefijo.
//  - Escrituras -> useMutation que, en onSuccess, invalida la clave de la feature para
//    que las listas en caché se refresquen solas (Local-First: el dato sólo cambia aquí).
//  - El hook envuelve las funciones de `*Apis.ts` (commands) sin tocar su firma.

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { clientesGetOverview, clientesRecalcularGasto, type FiltroRanking } from "./clientesApis";

/** Prefijo de claves de la feature; invalidar esto refresca todas sus listas. */
export const clientesKeys = {
  all: ["clientes"] as const,
  overview: (ranking: FiltroRanking) => ["clientes", "overview", ranking] as const,
};

/**
 * Lista/overview de clientes según el ranking seleccionado (cacheada por ranking). Al cambiar de
 * ranking se sigue enseñando la lista anterior hasta que llega la nueva, para que la pantalla no
 * parpadee.
 */
export function useClientesOverview(ranking: FiltroRanking) {
  return useQuery({
    queryKey: clientesKeys.overview(ranking),
    queryFn: () => clientesGetOverview({ ranking }),
    placeholderData: keepPreviousData,
  });
}

/** Alta de cliente; invalida la caché de clientes si el backend confirma el cambio. */
export function useCreateCliente() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: commands.clientesCreateCliente,
    onSuccess: (ok) => {
      if (ok) void qc.invalidateQueries({ queryKey: clientesKeys.all });
    },
  });
}

/** Edición de cliente; invalida la caché de clientes si el backend confirma el cambio. */
export function useUpdateCliente() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: commands.clientesUpdateCliente,
    onSuccess: (ok) => {
      if (ok) void qc.invalidateQueries({ queryKey: clientesKeys.all });
    },
  });
}

/**
 * Rehace el gasto acumulado desde los pagos (DB-14). Invalida siempre: el valor mostrado cambia
 * aunque el recálculo confirme el que ya había.
 */
export function useRecalcularGasto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: clientesRecalcularGasto,
    onSuccess: () => qc.invalidateQueries({ queryKey: clientesKeys.all }),
  });
}
