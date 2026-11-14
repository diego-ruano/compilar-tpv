// Hooks de TanStack Query para **mesas** (catálogo de solo-lectura).
//
// Conversión CONSERVADORA del POS: sólo se cachean las lecturas estables del layout de
// salones y la meta de mesas (se recargan en cada navegación a la vista de Mesas y casi
// nunca cambian). La lógica transaccional (abrir/cobrar comanda, cocina, edición de
// layout) se mantiene con llamadas directas: es el núcleo de ventas, alto riesgo y poco
// beneficio de caché.

import { useQuery } from "@tanstack/react-query";

import { mesasLoadLayout, mesasLoadPlano, type PlanoDeMesas } from "./mesasApi";

export const mesasKeys = {
  all: ["mesas"] as const,
  layout: () => ["mesas", "layout"] as const,
  meta: () => ["mesas", "meta"] as const,
};

/**
 * Lo más que se espera para releer la meta con el plano a la vista, aunque nada vaya a cambiar con
 * la hora: por si cambia algo que no avisa nadie (el reloj del equipo).
 */
export const RELECTURA_MAXIMA_META_MS = 15 * 60_000;

/**
 * Cuándo se relee la meta con el plano a la vista. La reserva de una mesa depende de la hora (sale
 * una hora antes, «en N min», y se va al acabar su hueco), y eso no lo avisa nadie: se relee cuando
 * la propia lectura dice que cambiará (`proximo_cambio_s`, MESAS-02), y no cada minuto. En la Main
 * es una lectura local; en la Handy, una petición al worker. Lo que cambia porque alguien escribe
 * llega por el aviso de cambios (`syncStatements.ts`).
 */
export function cuandoReleerLaMeta(plano: PlanoDeMesas | undefined): number {
  const s = plano?.proximoCambioS;
  if (s === null || s === undefined) return RELECTURA_MAXIMA_META_MS;
  return Math.min(Math.max(s, 1) * 1000, RELECTURA_MAXIMA_META_MS);
}

/** Layout de salones/mesas (cacheado; refetch manual para los botones de recarga). */
export function useMesasLayout(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: mesasKeys.layout(),
    queryFn: mesasLoadLayout,
    enabled: options?.enabled ?? true,
  });
}

/** Metadatos por mesa (estado de comanda, reserva); cacheado, y se relee cuando cambiará solo. */
export function useMesasMesaMeta(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: mesasKeys.meta(),
    queryFn: mesasLoadPlano,
    select: (plano) => plano.porMesa,
    enabled: options?.enabled ?? true,
    refetchInterval: (q) => cuandoReleerLaMeta(q.state.data),
  });
}
