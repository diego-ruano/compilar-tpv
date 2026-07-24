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
