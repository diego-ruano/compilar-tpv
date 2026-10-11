// src/shared/lib/plataforma.ts

/**
 * ¿Es la app de Android? Lo fija Tauri al compilar el frontend (`TAURI_ENV_PLATFORM`, que Vite deja
 * pasar por `envPrefix`). No es lo mismo que el modo Handy: un Windows también puede ser Handy.
 */
export const esAndroid = import.meta.env.TAURI_ENV_PLATFORM === "android";
