// src/shared/lib/plataforma.ts

/**
 * La plataforma la fija Tauri al compilar el frontend (`TAURI_ENV_PLATFORM`, que Vite deja pasar
 * por `envPrefix`). No es lo mismo que el modo Handy: un Windows también puede ser Handy.
 */
const plataforma = import.meta.env.TAURI_ENV_PLATFORM;

/**
 * ¿Es un teléfono o una tableta (Android o iPhone)? Ahí no hay ventana que mover, escalar ni
 * cerrar: el sistema ya pone lo suyo.
 */
export const esMovil = plataforma === "android" || plataforma === "ios";
