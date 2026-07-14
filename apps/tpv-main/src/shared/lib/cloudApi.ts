// shared/lib/cloudApi.ts
//
// Helper único para las peticiones autenticadas al worker `tpv-api` desde el frontend.
//
// La autenticación (firma device-proof: token + ts + firma ed25519 según el `mode`) la añade
// SIEMPRE el backend Rust en el comando `tpv_server_post_json`; aquí sólo se pasa el cuerpo
// plano. Centraliza lo que antes se copiaba a mano en cada sección (AppBoot, VincularHandy…),
// de modo que el patrón de petición vive en un único sitio.
//
// Para operaciones de pairing tipadas (p. ej. crear código) usa el comando hexagonal
// dedicado (`invokeClient("pair_create")`), no este proxy genérico.

import { invoke } from "@tauri-apps/api/core";

/**
 * Host del worker unificado `tpv-api`. Es el mismo que usa el backend Rust
 * (`CLOUD_API_BASE` en `crates/tpv-infra-licensing`); las peticiones REST no lo necesitan
 * (las compone Rust), pero el WebSocket sí lo abre el frontend.
 */
export const CLOUD_WS_URL = "wss://tpv-api.altarialights.workers.dev/ws";

/** Identidad con la que el backend firma la petición. */
export type CloudMode = "anon" | "tpv" | "handy";

/**
 * POST JSON firmado al worker `tpv-api` a través del proxy Rust `tpv_server_post_json`.
 *
 * @param mode Identidad de firma: `anon` (sin firma), `tpv` (token de licencia) o `handy`
 *             (token del keyring).
 * @param path Ruta del worker, debe empezar por `/` (p. ej. `/v1/pair/pending`).
 * @param body Cuerpo JSON plano (por defecto `{}`).
 */
export async function cloudPost<T = unknown>(
	mode: CloudMode,
	path: string,
	body: unknown = {},
): Promise<T> {
	return invoke<T>("tpv_server_post_json", { args: { mode, path, body } });
}
