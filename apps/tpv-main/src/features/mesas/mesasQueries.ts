// Hooks de TanStack Query para **mesas** (catálogo de solo-lectura).
//
// Conversión CONSERVADORA del POS: sólo se cachean las lecturas estables del layout de
// salones y la meta de mesas (se recargan en cada navegación a la vista de Mesas y casi
// nunca cambian). La lógica transaccional (abrir/cobrar comanda, cocina, edición de
// layout) se mantiene con llamadas directas: es el núcleo de ventas, alto riesgo y poco
// beneficio de caché.

import { useQuery } from "@tanstack/react-query";

import { mesasLoadLayout, mesasLoadMesaMeta } from "./mesasApi";

export const mesasKeys = {
  all: ["mesas"] as const,
  layout: () => ["mesas", "layout"] as const,
  meta: () => ["mesas", "meta"] as const,
};

/**
 * Cada cuánto se relee la meta con el plano a la vista. La reserva de una mesa depende de la hora
 * (sale una hora antes, «en N min», y se va al acabar su hueco), y eso no lo avisa nadie: con el
 * plano abierto, una reserva no aparecía hasta que algo lo recargaba. En la Main es una lectura
 * local; en la Handy, una petición al worker por minuto (MESAS-02).
 */
const REFRESCO_META_MS = 60_000;

/** Layout de salones/mesas (cacheado; refetch manual para los botones de recarga). */
export function useMesasLayout(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: mesasKeys.layout(),
    queryFn: mesasLoadLayout,
    enabled: options?.enabled ?? true,
  });
}

/** Metadatos por mesa (estado de comanda, reserva); cacheado, y se relee cada minuto. */
export function useMesasMesaMeta(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: mesasKeys.meta(),
    queryFn: mesasLoadMesaMeta,
    enabled: options?.enabled ?? true,
    refetchInterval: REFRESCO_META_MS,
  });
}
