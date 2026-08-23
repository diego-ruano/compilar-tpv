// src/features/notificaciones/notificacionesApis.ts
//
// API de notificaciones. En modo TPV/Main invoca los comandos Tauri contra el SQLite local; en
// modo Handy los mismos comandos hablan por HTTP contra la nube (el repo lo resuelve el backend
// según el modo). Las firmas no cambian entre modos.

import { invokeClient } from "@tpv/client";
import type { NotificacionRow } from "@tpv/contracts";

export type { NotificacionRow };

/** Notificaciones visibles del usuario (activas y no caducadas). */
export async function notificacionesListar(params: {
  idUsuario: string;
  soloNoLeidas?: boolean;
}): Promise<NotificacionRow[]> {
  const rows = await invokeClient<NotificacionRow[]>("notificaciones_listar", {
    args: {
      id_usuario: params.idUsuario,
      solo_no_leidas: params.soloNoLeidas ?? false,
    },
  });
  return rows ?? [];
}

/** Nº de no leídas del usuario (para el badge de la campana). */
export async function notificacionesNoLeidas(params: {
  idUsuario: string;
}): Promise<number> {
  const n = await invokeClient<number>("notificaciones_no_leidas", {
    args: { id_usuario: params.idUsuario },
  });
  return Number(n ?? 0);
}

/** Marca una notificación como leída por el usuario. */
export async function notificacionesMarcarLeida(params: {
  idNotificacion: string;
  idUsuario: string;
}): Promise<boolean> {
  return await invokeClient<boolean>("notificaciones_marcar_leida", {
    args: {
      id_notificacion: params.idNotificacion,
      id_usuario: params.idUsuario,
    },
  });
}

/** Marca todas las visibles del usuario como leídas. Devuelve cuántas marcó. */
export async function notificacionesMarcarTodasLeidas(params: {
  idUsuario: string;
}): Promise<number> {
  const n = await invokeClient<number>("notificaciones_marcar_todas_leidas", {
    args: { id_usuario: params.idUsuario },
  });
  return Number(n ?? 0);
}

/**
 * Manda una notificación a la papelera. Es un cambio de estado reversible (`descartada`), no un
 * borrado: la fila sigue ahí hasta que alguien la elimine desde la papelera.
 */
export async function notificacionesDescartar(params: {
  idNotificacion: string;
}): Promise<boolean> {
  return await invokeClient<boolean>("notificaciones_descartar", {
    args: { id_notificacion: params.idNotificacion },
  });
}

/** Contenido de la papelera del usuario (lo descartado que él puede ver). */
export async function notificacionesPapelera(params: {
  idUsuario: string;
}): Promise<NotificacionRow[]> {
  const rows = await invokeClient<NotificacionRow[]>("notificaciones_papelera", {
    args: { id_usuario: params.idUsuario },
  });
  return rows ?? [];
}

/** Saca una notificación de la papelera y la devuelve al centro. */
export async function notificacionesRestaurar(params: {
  idNotificacion: string;
}): Promise<boolean> {
  return await invokeClient<boolean>("notificaciones_restaurar", {
    args: { id_notificacion: params.idNotificacion },
  });
}

/** Borra una notificación para siempre. Sin vuelta atrás. */
export async function notificacionesEliminar(params: {
  idNotificacion: string;
}): Promise<boolean> {
  return await invokeClient<boolean>("notificaciones_eliminar", {
    args: { id_notificacion: params.idNotificacion },
  });
}
