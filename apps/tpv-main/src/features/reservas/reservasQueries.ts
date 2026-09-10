// Hooks de TanStack Query para **reservas** (sigue el patrón de `clientesQueries.ts`).
//
//  - Lecturas  -> useQuery con queryKey con el nombre de la feature como prefijo.
//  - Escrituras -> useMutation que, en onSuccess, invalida la clave de la feature para
//    que las listas en caché se refresquen solas (Local-First: el dato sólo cambia aquí).
//  - El hook envuelve las funciones de `reservasApis.ts` (invokeClient) sin tocar su firma.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  reservasGetMeta,
  reservasGetMes,
  reservasSave,
  reservasDelete,
} from "./reservasApis";

/** Prefijo de claves de la feature; invalidar esto refresca todas sus listas. */
export const reservasKeys = {
  all: ["reservas"] as const,
  meta: () => ["reservas", "meta"] as const,
  mes: (desde: string, hasta: string) => ["reservas", "mes", desde, hasta] as const,
};

/** Meta de reservas (zonas + mesas), cacheada. */
export function useReservasMeta() {
  return useQuery({
    queryKey: reservasKeys.meta(),
    queryFn: () => reservasGetMeta(),
  });
}

/** Reservas del rango (mes) indicado, cacheadas por rango desde/hasta. */
export function useReservasMes(desde: string, hasta: string) {
  return useQuery({
    queryKey: reservasKeys.mes(desde, hasta),
    queryFn: () => reservasGetMes({ desde, hasta }),
  });
}

/** Alta/edición de reserva; invalida la caché de reservas si el backend confirma. */
export function useSaveReserva() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: reservasSave,
    onSuccess: (ok) => {
      if (ok) void qc.invalidateQueries({ queryKey: reservasKeys.all });
    },
  });
}

/** Borrado de reserva; invalida la caché de reservas si el backend confirma. */
export function useDeleteReserva() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: reservasDelete,
    onSuccess: (ok) => {
      if (ok) void qc.invalidateQueries({ queryKey: reservasKeys.all });
    },
  });
}
