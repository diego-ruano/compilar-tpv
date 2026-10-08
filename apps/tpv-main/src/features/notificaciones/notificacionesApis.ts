import { commands } from "@tpv/client";
// src/features/notificaciones/notificacionesApis.ts
//
// API de notificaciones. En modo TPV/Main invoca los comandos Tauri contra el SQLite local; en
// modo Handy los mismos comandos hablan por HTTP contra la nube (el repo lo resuelve el backend
// según el modo). Las firmas no cambian entre modos.


import type { NotificacionRow } from "@tpv/contracts";

export type { NotificacionRow };

/** Notificaciones visibles del usuario (activas y no caducadas). */
export async function notificacionesListar(params: {
  id_usuario: string;
  solo_no_leidas?: boolean;
}): Promise<NotificacionRow[]> {
  const rows = await commands.notificacionesListar({
      id_usuario: params.id_usuario,
      solo_no_leidas: params.solo_no_leidas ?? false,
    });
  return rows ?? [];
}

/** Nº de no leídas del usuario (para el badge de la campana). */
export async function notificacionesNoLeidas(params: {
  id_usuario: string;
}): Promise<number> {
  const n = await commands.notificacionesNoLeidas({ id_usuario: params.id_usuario });
  return Number(n ?? 0);
}

/** Marca una notificación como leída por el usuario. */
export const notificacionesMarcarLeida = commands.notificacionesMarcarLeida;

/** Marca todas las visibles del usuario como leídas. Devuelve cuántas marcó. */
export async function notificacionesMarcarTodasLeidas(params: {
  id_usuario: string;
}): Promise<number> {
  const n = await commands.notificacionesMarcarTodasLeidas({ id_usuario: params.id_usuario });
  return Number(n ?? 0);
}

/**
 * Manda una notificación a la papelera. Es un cambio de estado reversible (`descartada`), no un
 * borrado: la fila sigue ahí hasta que alguien la elimine desde la papelera.
 */
export const notificacionesDescartar = commands.notificacionesDescartar;

/** Contenido de la papelera del usuario (lo descartado que él puede ver). */
export async function notificacionesPapelera(params: {
  id_usuario: string;
}): Promise<NotificacionRow[]> {
  const rows = await commands.notificacionesPapelera({ id_usuario: params.id_usuario });
  return rows ?? [];
}

/** Saca una notificación de la papelera y la devuelve al centro. */
export const notificacionesRestaurar = commands.notificacionesRestaurar;

/** Borra una notificación para siempre. Sin vuelta atrás. */
export const notificacionesEliminar = commands.notificacionesEliminar;
