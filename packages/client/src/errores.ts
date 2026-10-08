// Errores del contrato IPC. Los comandos generados usan el transporte interno.
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
