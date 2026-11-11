// src/features/notificaciones/notificacionesQueries.ts
//
// Hooks TanStack Query de notificaciones. Las lecturas se cachean por usuario; las mutaciones
// (marcar leída / todas) invalidan la clave de la feature para refrescar lista + contador.
//
// El `idUsuario` que reciben las lecturas sólo separa la caché de cada persona y apaga la consulta
// sin sesión: al backend no llega, que saca el usuario de la sesión (AUD-26).
//
// Nota de sincronización: cuando llega un `change` por WebSocket que toca `Notificaciones` /
// `Notificacion_Lecturas`, el socket (Main o Handy) invalida la clave ["notificaciones"] (ver
// TABLE_TO_FEATURES en shared/lib/syncStatements.ts), así que la lista/badge se refrescan al
// instante sin que aquí haya que hacer polling.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  notificacionesDescartar,
  notificacionesEliminar,
  notificacionesListar,
  notificacionesMarcarLeida,
  notificacionesMarcarTodasLeidas,
  notificacionesNoLeidas,
  notificacionesPapelera,
  notificacionesRestaurar,
} from "./notificacionesApis";

/** Prefijo de claves de la feature; invalidar esto refresca lista y contador. */
export const notificacionesKeys = {
  all: ["notificaciones"] as const,
  lista: (idUsuario: string, soloNoLeidas: boolean) =>
    ["notificaciones", "lista", idUsuario, soloNoLeidas] as const,
  noLeidas: (idUsuario: string) => ["notificaciones", "noLeidas", idUsuario] as const,
  papelera: (idUsuario: string) => ["notificaciones", "papelera", idUsuario] as const,
};

/** Lista de notificaciones del usuario (deshabilitada sin sesión). */
export function useNotificaciones(idUsuario: string | null, soloNoLeidas = false) {
  return useQuery({
    queryKey: notificacionesKeys.lista(idUsuario ?? "", soloNoLeidas),
    queryFn: () => notificacionesListar({ solo_no_leidas: soloNoLeidas }),
    enabled: !!idUsuario,
  });
}

/** Contador de no leídas del usuario (para el badge de la campana). */
export function useNoLeidasCount(idUsuario: string | null) {
  return useQuery({
    queryKey: notificacionesKeys.noLeidas(idUsuario ?? ""),
    queryFn: () => notificacionesNoLeidas(),
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
    mutationFn: () => notificacionesMarcarTodasLeidas(),
    onSuccess: () => qc.invalidateQueries({ queryKey: notificacionesKeys.all }),
  });
}

/** Contenido de la papelera del usuario (sólo se consulta con el modal abierto). */
export function usePapelera(idUsuario: string | null, activa: boolean) {
  return useQuery({
    queryKey: notificacionesKeys.papelera(idUsuario ?? ""),
    queryFn: () => notificacionesPapelera(),
    enabled: !!idUsuario && activa,
  });
}

/**
 * Las tres acciones de la papelera invalidan la feature ENTERA, no sólo su lista: descartar quita
 * la notificación del centro y del contador de no leídas, y restaurar la devuelve. Media
 * invalidación dejaría el badge diciendo una cosa y la lista otra.
 */
function useAccionPapelera<T>(mutationFn: (v: T) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => qc.invalidateQueries({ queryKey: notificacionesKeys.all }),
  });
}

/** Manda una notificación a la papelera. */
export function useDescartar() {
  return useAccionPapelera(notificacionesDescartar);
}

/** Devuelve una notificación de la papelera al centro. */
export function useRestaurar() {
  return useAccionPapelera(notificacionesRestaurar);
}

/** Borra una notificación para siempre. */
export function useEliminar() {
  return useAccionPapelera(notificacionesEliminar);
}
