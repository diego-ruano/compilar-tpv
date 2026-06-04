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

/** Layout de salones/mesas (cacheado; refetch manual para los botones de recarga). */
export function useMesasLayout() {
  return useQuery({
    queryKey: mesasKeys.layout(),
    queryFn: mesasLoadLayout,
  });
}

/** Metadatos por mesa (estado de comanda, etc.); cacheado y refetcheable. */
export function useMesasMesaMeta() {
  return useQuery({
    queryKey: mesasKeys.meta(),
    queryFn: mesasLoadMesaMeta,
  });
}
