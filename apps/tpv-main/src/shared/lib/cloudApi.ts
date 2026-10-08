import { commands } from "@tpv/client";
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
// dedicado (`commands.pairCreate`), no este proxy genérico.



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
export async function cloudPost(
	mode: CloudMode,
	path: string,
	body: unknown = {},
): Promise<unknown> {
	return commands.tpvServerPostJson({ mode, path, body });
}
