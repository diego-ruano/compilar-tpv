// src/lib/errorCodes.ts
//
// Catálogo de códigos de error del worker (ARCH-02 / ARCH-05).
//
// `ErrorCode` NO se define aquí: se importa de `@tpv/contracts`, que lo genera ts-rs
// desde `crates/tpv-contracts/src/errors.rs`. Rust, el worker y el frontend comparten
// exactamente el mismo conjunto cerrado, y añadir un código en Rust sin contemplarlo
// aquí es un error de compilación, no una sorpresa en producción.
//
// Forma de la respuesta de error del worker:
//
//   { ok: false, code: ErrorCode, error: string, ... }
//
//   · `code`  → estable y cerrado. Es por lo que ramifican el cliente Rust y la UI.
//   · `error` → el string de siempre. Se conserva como diagnóstico y porque es lo que
//               leen los clientes ya instalados; NADIE debe ramificar por él.

import type { ErrorCode } from "@tpv/contracts";

/**
 * Códigos de negocio: el string que el worker ya emitía → código del catálogo.
 *
 * Espejo exacto de `ErrorCode::from_wire` en `crates/tpv-contracts/src/errors.rs`.
 * Si cambias uno, cambia el otro: es la pareja que mantiene el contrato.
 */
const NEGOCIO: Record<string, ErrorCode> = {
	not_approved: "not_approved",
	main_offline: "main_offline",
	device_revoked: "device_revoked",
	revoked: "device_revoked",
	license_expired: "license_expired",
	expired: "license_expired",
	no_active_license_for_tenant: "license_not_found",
	license_not_found: "license_not_found",
	invalid_pin: "invalid_pin",
	validation_error: "validation",
	not_found: "not_found",
};

/** Clasificación por defecto cuando el string no es un código de negocio conocido. */
function porEstado(status: number): ErrorCode {
	if (status === 404) return "not_found";
	if (status === 409) return "conflict";
	if (status >= 500) return "internal";
	if (status === 400 || status === 422) return "validation";
	// 401/403 y demás: el detalle va en `error`; para el cliente es un fallo externo.
	return "external";
}

/**
 * Resuelve el código a partir del string de siempre y del status HTTP.
 *
 * Los códigos ad-hoc que nadie ramifica (`id_mesa invalido`, `missing_tenant_id`…) caen
 * a la clasificación por estado **a propósito**: el catálogo sólo contiene aquello por lo
 * que alguien decide algo distinto. Su texto sigue viajando en `error`.
 */
export function wireToCode(error: string, status: number): ErrorCode {
	// Se normaliza igual que `ErrorCode::from_wire` en Rust: recortar y bajar a minúsculas.
	// El código de una respuesta no puede depender de cómo lo escribiera quien la emitió, y
	// los dos lados tienen que coincidir — hay un fixture compartido que lo comprueba.
	const clave = String(error ?? "")
		.trim()
		.toLowerCase();

	return NEGOCIO[clave] ?? porEstado(status);
}
