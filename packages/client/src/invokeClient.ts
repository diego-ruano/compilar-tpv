// packages/client/src/invokeClient.ts
//
// Cliente unificado **Local-First** del TPV.
//
// Envuelve `invoke()` de @tauri-apps/api/core asumiendo latencia cero y éxito
// instantáneo contra el SQLite local del dispositivo. Sustituye por completo al
// antiguo patrón síncrono dual (red + local) de `dualCall.ts`: aquí NO hay red,
// NO hay outbox, NO hay fallback; el frontend invoca directamente el comando Tauri.
//
// ## Errores (ARCH-02 / ARCH-05)
//
// Todo comando Tauri devuelve `Result<T, AppErrorDto>`, así que un rechazo trae
// SIEMPRE `{ code, message }`:
//
//   · `code`    → del catálogo cerrado `ErrorCode`, compartido con Rust y el worker.
//                 Es lo único por lo que se debe ramificar; TypeScript valida el nombre.
//   · `message` → texto diagnóstico. Se muestra y se registra. **Nunca se compara.**
//
// Ya no existe el `catch (e) { String(e) }` de antes: comparar el texto de un error
// hacía que reescribir un mensaje pudiera romper una rama de la UI en silencio.

import { invoke } from "@tauri-apps/api/core";
import type { AppErrorDto, ErrorCode } from "@tpv/contracts";

export type { AppErrorDto, ErrorCode };

/** ¿Es un error del contrato (`{ code, message }`) y no otra cosa? */
export function isAppError(value: unknown): value is AppErrorDto {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AppErrorDto).code === "string" &&
    typeof (value as AppErrorDto).message === "string"
  );
}

/**
 * Normaliza cualquier valor capturado a un `AppErrorDto`.
 *
 * Los comandos rechazan siempre con el DTO, pero un `catch` puede recibir otra cosa
 * cuando el fallo es del propio Tauri y no del comando (comando no registrado, error
 * de serialización del IPC) o cuando el throw viene de código JS. Esos casos se
 * clasifican como `internal`: así el llamante puede tratar SIEMPRE `e.code` y
 * `e.message` sin comprobar la forma.
 */
export function toAppError(value: unknown): AppErrorDto {
  if (isAppError(value)) return value;

  if (value instanceof Error) {
    return { code: "internal", message: value.message };
  }

  if (typeof value === "string" && value.trim() !== "") {
    return { code: "internal", message: value };
  }

  return { code: "internal", message: "Error interno" };
}

/** Atajo legible: `esError(e, "not_approved")`. */
export function esError(value: unknown, code: ErrorCode): boolean {
  return toAppError(value).code === code;
}

/**
 * Invoca un comando de Tauri contra el backend local.
 *
 * @param command Nombre estable del comando registrado en Rust (`#[tauri::command]`).
 * @param args    Argumentos del comando (objeto que Tauri serializa a los parámetros).
 * @returns       El resultado deserializado del comando.
 * @throws        `AppErrorDto` — siempre, nunca un string suelto.
 *
 * @example
 * try {
 *   const lineas = await invokeClient<LineaComanda[]>("get_lineas_comanda", { comandaId });
 * } catch (e) {
 *   const err = toAppError(e);
 *   if (err.code === "conflict") … else toast(err.message);
 * }
 */
export async function invokeClient<T = unknown>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (e) {
    throw toAppError(e);
  }
}

/** Acceso directo al `invoke` crudo de Tauri por si se necesita en casos límite. */
export { invoke as rawInvoke };
