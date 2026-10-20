// Hooks de TanStack Query para **reservas** (sigue el patrón de `clientesQueries.ts`).
//
//  - Lecturas  -> useQuery con queryKey con el nombre de la feature como prefijo.
//  - Escrituras -> useMutation que, en onSuccess, invalida lo que enseña una reserva para que las
//    listas en caché se refresquen solas (`refrescarTrasCambiarReservas`).
//  - El hook envuelve las funciones de `reservasApis.ts` (commands) sin tocar su firma.

import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { commands } from "@tpv/client";

import { clientesKeys } from "../clientes/clientesQueries";
import { statsKeys } from "../estadisticas/statsQueries";
import { mesasKeys } from "../mesas/mesasQueries";

/** Prefijo de claves de la feature; invalidar esto refresca todas sus listas. */
export const reservasKeys = {
  all: ["reservas"] as const,
  meta: () => ["reservas", "meta"] as const,
  mes: (desde: string, hasta: string) => ["reservas", "mes", desde, hasta] as const,
};

/**
 * Tras cambiar una reserva desde esta app: el calendario, el plano (la reserva de cada mesa), los
 * clientes (guardar puede crear o completar la ficha, y su resumen cuenta las reservas) y las
 * estadísticas. Antes sólo se invalidaba `reservas`, y el plano seguía enseñando la mesa reservada
 * (o libre) hasta que alguien lo recargaba. Lo que cambia en otro equipo llega por `sync:cambio`.
 */
export function refrescarTrasCambiarReservas(qc: QueryClient) {
  for (const queryKey of [reservasKeys.all, mesasKeys.meta(), clientesKeys.all, statsKeys.all]) {
    void qc.invalidateQueries({ queryKey });
  }
}

/** Meta de reservas (zonas + mesas), cacheada. */
export function useReservasMeta() {
  return useQuery({
    queryKey: reservasKeys.meta(),
    queryFn: () => commands.reservasGetMeta(),
  });
}

/** Reservas del rango (mes) indicado, cacheadas por rango desde/hasta. */
export function useReservasMes(desde: string, hasta: string) {
  return useQuery({
    queryKey: reservasKeys.mes(desde, hasta),
    queryFn: () => commands.reservasGetMes({ desde, hasta }),
  });
}

/** Alta/edición de reserva; refresca lo que la enseña si el backend confirma. */
export function useSaveReserva() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: commands.reservasSave,
    onSuccess: (ok) => {
      if (ok) refrescarTrasCambiarReservas(qc);
    },
  });
}

/** Borrado de reserva: desaparece. Refresca lo que la enseña si el backend confirma. */
export function useDeleteReserva() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: commands.reservasDelete,
    onSuccess: (ok) => {
      if (ok) refrescarTrasCambiarReservas(qc);
    },
  });
}

/** Cancelar una reserva que aún no ha llegado: se queda, cancelada. Refresca como el borrado. */
export function useCancelarReserva() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: commands.reservasCancelar,
    onSuccess: (ok) => {
      if (ok) refrescarTrasCambiarReservas(qc);
    },
  });
}
