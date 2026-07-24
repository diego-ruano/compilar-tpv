// src/features/notificaciones/notificacionesQueries.ts
//
// Hooks TanStack Query de notificaciones. Las lecturas se cachean por usuario; las mutaciones
// (marcar leída / todas) invalidan la clave de la feature para refrescar lista + contador.
//
// Nota de sincronización: cuando llega un `change` por WebSocket que toca `Notificaciones` /
// `Notificacion_Lecturas`, el socket (Main o Handy) invalida la clave ["notificaciones"] (ver
// TABLE_TO_FEATURES en shared/lib/syncStatements.ts), así que la lista/badge se refrescan al
// instante sin que aquí haya que hacer polling.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  notificacionesListar,
  notificacionesMarcarLeida,
  notificacionesMarcarTodasLeidas,
  notificacionesNoLeidas,
} from "./notificacionesApis";

/** Prefijo de claves de la feature; invalidar esto refresca lista y contador. */
export const notificacionesKeys = {
  all: ["notificaciones"] as const,
  lista: (idUsuario: string, soloNoLeidas: boolean) =>
    ["notificaciones", "lista", idUsuario, soloNoLeidas] as const,
  noLeidas: (idUsuario: string) => ["notificaciones", "noLeidas", idUsuario] as const,
};

/** Lista de notificaciones del usuario (deshabilitada sin sesión). */
export function useNotificaciones(idUsuario: string | null, soloNoLeidas = false) {
  return useQuery({
    queryKey: notificacionesKeys.lista(idUsuario ?? "", soloNoLeidas),
    queryFn: () => notificacionesListar({ idUsuario: idUsuario as string, soloNoLeidas }),
    enabled: !!idUsuario,
  });
}

/** Contador de no leídas del usuario (para el badge de la campana). */
export function useNoLeidasCount(idUsuario: string | null) {
  return useQuery({
    queryKey: notificacionesKeys.noLeidas(idUsuario ?? ""),
    queryFn: () => notificacionesNoLeidas({ idUsuario: idUsuario as string }),
    enabled: !!idUsuario,
  });
}

/** Marca una notificación como leída; invalida la feature. */
export function useMarcarLeida() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: notificacionesMarcarLeida,
    onSuccess: () => qc.invalidateQueries({ queryKey: notificacionesKeys.all }),
  });
}

/** Marca todas como leídas; invalida la feature. */
export function useMarcarTodasLeidas() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: notificacionesMarcarTodasLeidas,
    onSuccess: () => qc.invalidateQueries({ queryKey: notificacionesKeys.all }),
  });
}
