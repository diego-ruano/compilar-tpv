import { commands } from "@tpv/client";
// src/features/notificaciones/notificacionesApis.ts
//
// API de notificaciones. En modo TPV/Main invoca los comandos Tauri contra el SQLite local; en
// modo Handy los mismos comandos hablan por HTTP contra la nube (el repo lo resuelve el backend
// según el modo). Las firmas no cambian entre modos.
//
// AUD-26: el usuario no viaja. Las notificaciones son las de quien ha iniciado sesión, y eso lo
// sabe el backend: la pantalla no elige en nombre de quién se lee ni se marca.


import type { NotificacionRow } from "@tpv/contracts";

export type { NotificacionRow };

/** Notificaciones visibles de quien ha iniciado sesión (activas y no caducadas). */
export async function notificacionesListar(params: {
  solo_no_leidas?: boolean;
}): Promise<NotificacionRow[]> {
  const rows = await commands.notificacionesListar({
      solo_no_leidas: params.solo_no_leidas ?? false,
    });
  return rows ?? [];
}

/** Nº de no leídas de quien ha iniciado sesión (para el badge de la campana). */
export async function notificacionesNoLeidas(): Promise<number> {
  const n = await commands.notificacionesNoLeidas();
  return Number(n ?? 0);
}

/** Marca una notificación como leída por quien ha iniciado sesión. */
export const notificacionesMarcarLeida = commands.notificacionesMarcarLeida;

/** Marca todas las visibles como leídas. Devuelve cuántas marcó. */
export async function notificacionesMarcarTodasLeidas(): Promise<number> {
  const n = await commands.notificacionesMarcarTodasLeidas();
  return Number(n ?? 0);
}

/**
 * Manda una notificación a la papelera. Es un cambio de estado reversible (`descartada`), no un
 * borrado: la fila sigue ahí hasta que alguien la elimine desde la papelera.
 */
export const notificacionesDescartar = commands.notificacionesDescartar;

/** Contenido de la papelera de quien ha iniciado sesión (lo descartado que él puede ver). */
export async function notificacionesPapelera(): Promise<NotificacionRow[]> {
  const rows = await commands.notificacionesPapelera();
  return rows ?? [];
}

/** Saca una notificación de la papelera y la devuelve al centro. */
export const notificacionesRestaurar = commands.notificacionesRestaurar;

/** Borra una notificación para siempre. Sin vuelta atrás. */
export const notificacionesEliminar = commands.notificacionesEliminar;
