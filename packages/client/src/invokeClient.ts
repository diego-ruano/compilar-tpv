// packages/client/src/invokeClient.ts
//
// Cliente unificado **Local-First** del TPV.
//
// Envuelve `invoke()` de @tauri-apps/api/core asumiendo latencia cero y éxito
// instantáneo contra el SQLite local del dispositivo. Sustituye por completo al
// antiguo patrón síncrono dual (red + local) de `dualCall.ts`: aquí NO hay red,
// NO hay outbox, NO hay fallback; el frontend invoca directamente el comando Tauri.

import { invoke } from "@tauri-apps/api/core";

/**
 * Invoca un comando de Tauri contra el backend local.
 *
 * @param command Nombre estable del comando registrado en Rust (`#[tauri::command]`).
 * @param args    Argumentos del comando (objeto que Tauri serializa a los parámetros).
 * @returns       El resultado deserializado del comando.
 *
 * @example
 * const lineas = await invokeClient<LineaComanda[]>("get_lineas_comanda", { comandaId });
 */
export async function invokeClient<T = unknown>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  return invoke<T>(command, args);
}

/** Acceso directo al `invoke` crudo de Tauri por si se necesita en casos límite. */
export { invoke as rawInvoke };
