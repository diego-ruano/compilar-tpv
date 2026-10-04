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
	main_volcando: "main_offline",
	device_revoked: "device_revoked",
	revoked: "device_revoked",
	license_expired: "license_expired",
	expired: "license_expired",
	license_revoked: "license_expired",
	device_replaced: "device_revoked",
	device_not_registered: "device_revoked",
	no_active_license_for_tenant: "license_not_found",
	license_not_found: "license_not_found",
	invalid_pin: "invalid_pin",
	tenant_db_not_provisioned: "tenant_db_not_provisioned",
	bootstrap_demasiado_grande: "bootstrap_too_large",
	bootstrap_too_large: "bootstrap_too_large",
	migration_altered: "tenant_migration_altered",
	tenant_migration_altered: "tenant_migration_altered",
	backup_corrupt: "backup_corrupt",
	permiso_denegado: "permiso_denegado",
	datos_fiscales_incompletos: "datos_fiscales_incompletos",
	factura_completa_requerida: "factura_completa_requerida",
	// FISCAL-01: la Handy no cobra, así que no emite registros — pero el veto de
	// `applyViaHub` sí sale por aquí si alguna ruta futura lo intenta.
	escritura_solo_en_main: "permiso_denegado",
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

	return propia(NEGOCIO, clave) ?? porEstado(status);
}

/** Busca sólo claves propias: `NEGOCIO["constructor"]` no puede devolver lo del prototipo. */
function propia<T>(tabla: Readonly<Record<string, T>>, clave: string): T | undefined {
	return Object.prototype.hasOwnProperty.call(tabla, clave) ? tabla[clave] : undefined;
}

/**
 * Todos los valores del catálogo. `Record<ErrorCode, true>` obliga a que estén todos y a que no
 * sobre ninguno: si Rust añade un código, esto deja de compilar hasta que se añada aquí.
 */
const CODIGOS: Record<ErrorCode, true> = {
	validation: true,
	not_found: true,
	conflict: true,
	repository: true,
	external: true,
	internal: true,
	not_approved: true,
	main_offline: true,
	device_revoked: true,
	license_expired: true,
	license_not_found: true,
	invalid_pin: true,
	tenant_db_not_provisioned: true,
	bootstrap_too_large: true,
	tenant_migration_altered: true,
	backup_corrupt: true,
	permiso_denegado: true,
	datos_fiscales_incompletos: true,
	factura_completa_requerida: true,
};

export function esCodigoDelCatalogo(valor: unknown): valor is ErrorCode {
	return typeof valor === "string" && propia(CODIGOS, valor) === true;
}

// ── Lo que se le enseña a quien está delante ─────────────────────────────────────────────
//
// El `error` de una respuesta es un identificador de máquina (`pair_code_not_found`). El cliente
// pinta `message`, y cuando una respuesta no lo traía pintaba el identificador tal cual: el
// camarero leía `pair_code_not_found`. Estas dos listas deciden, para cada identificador que emite
// el worker, qué ve la persona:
//
//   · MENSAJES: los que alguien puede provocar usando el programa. Llevan una frase que dice qué
//     ha pasado y, si lo hay, qué hacer.
//   · SIN_MENSAJE_PROPIO: los que no la necesitan. O ya se traducen a un código de negocio cuyo
//     texto genérico basta (`main_offline`), o son internos y sólo salen si hay un bug (firmas,
//     pasos del DO, Stripe, administración). Esos viajan sin `message`, y el cliente enseña el
//     genérico de su código con el identificador entre paréntesis, que es lo que le sirve a soporte.
//
// Un identificador nuevo tiene que entrar en una de las dos, o `test/mensajesDeError.test.ts` se
// pone rojo: lee el fuente entero del worker. Si la respuesta ya trae su propio `message` (el de
// la llamada puede ser más preciso: «El código son 6 cifras»), manda ése; la tabla sólo rellena.
// Quien lo aplica a TODAS las respuestas es `middleware/completarErrores.ts`.

const VOLVER_A_VINCULAR = "Este dispositivo no está autorizado. Vuelve a vincularlo o a activar la licencia.";
const HORA_MAL = "La fecha y la hora de este dispositivo no son correctas. Ajústalas y vuelve a intentarlo.";
const CODIGO_USADO = "Ese código de vinculación ya se ha usado. Genera uno nuevo en el TPV principal.";
const SOLICITUD_CADUCADA = "La solicitud de vinculación ha caducado. Vuelve a pulsar «Vincular dispositivo».";
const SOLO_EN_LA_MAIN = "Esto sólo se puede hacer desde el TPV principal.";

export const MENSAJES: Readonly<Record<string, string>> = {
	// Emparejamiento de una Handy
	invalid_pair_code: "El código de vinculación son 6 cifras.",
	invalid_pair_secret: "El QR no es válido. Vuelve a escanearlo o escribe el código a mano.",
	pair_code_not_found:
		"Ese código de vinculación no existe. Revisa las cifras o genera uno nuevo en el TPV principal.",
	pair_code_expired: "El código de vinculación ha caducado. Genera uno nuevo en el TPV principal.",
	pair_code_used: CODIGO_USADO,
	already_used: CODIGO_USADO,
	pair_code_used_or_invalid_state: CODIGO_USADO,
	pair_code_already_approved:
		"Ese código ya se aprobó para otro dispositivo. Genera uno nuevo en el TPV principal.",
	pair_claim_race_or_invalid_state:
		"Otro dispositivo ya está usando ese código. Genera uno nuevo en el TPV principal.",
	invalid_pair_status:
		"Ese código de vinculación ya no se puede usar. Genera uno nuevo en el TPV principal.",
	device_mismatch: "Ese código de vinculación lo está usando otro dispositivo.",
	challenge_expired: SOLICITUD_CADUCADA,
	challenge_not_found: SOLICITUD_CADUCADA,
	challenge_used: SOLICITUD_CADUCADA,
	challenge_used_or_expired: SOLICITUD_CADUCADA,
	no_claim_to_approve: "Ningún dispositivo ha usado todavía ese código.",
	pair_approve_race_or_invalid_state: "Esa solicitud ya no está pendiente. Actualiza la lista.",
	wrong_tenant: "Esa solicitud es de otro negocio.",
	cannot_revoke_self: "Un dispositivo no puede revocarse a sí mismo.",
	forbidden_not_main: SOLO_EN_LA_MAIN,
	forbidden_not_tpv: SOLO_EN_LA_MAIN,
	too_many_attempts: "Demasiados intentos fallidos. Espera un poco antes de volver a intentarlo.",
	pair_rejected: "El TPV principal ha rechazado la vinculación. Si es un error, genera un código nuevo en el TPV principal.",

	// Autorización del dispositivo
	missing_token: VOLVER_A_VINCULAR,
	invalid_token: VOLVER_A_VINCULAR,
	invalid_token_claims: VOLVER_A_VINCULAR,
	invalid_jwt: VOLVER_A_VINCULAR,
	jwt_expired: "La autorización de este dispositivo ha caducado. Cierra y vuelve a abrir la aplicación.",
	token_expired: "La autorización de este dispositivo ha caducado. Cierra y vuelve a abrir la aplicación.",
	device_not_registered: "Este dispositivo no está dado de alta. Vuelve a vincularlo.",
	device_pubkey_not_registered: "Este dispositivo no está dado de alta. Vuelve a vincularlo.",
	device_pubkey_mismatch:
		"La identidad de este dispositivo no coincide con la registrada. Vuelve a vincularlo.",
	missing_device_proof: "La firma de este dispositivo no es válida. Vuelve a vincularlo.",
	bad_device_signature: "La firma de este dispositivo no es válida. Vuelve a vincularlo.",
	device_ts_out_of_range: HORA_MAL,
	timestamp_out_of_range: HORA_MAL,
	main_volcando: "El TPV principal está terminando de subir sus datos. Espera un momento.",

	// Operativa
	email_duplicado: "Ya hay un cliente con ese correo.",
	asignacion_duplicada: "Ese trabajador ya tiene ese turno asignado ese día.",
	// RI-62: el mismo texto que da la Main (`MSG_ULTIMO_ADMINISTRADOR`).
	ultimo_administrador:
		"No se puede dejar el negocio sin ningún administrador activo. Da antes el rol de Administrador a otra persona.",
	trabajador_inexistente: "Alguno de los trabajadores elegidos ya no existe. Actualiza la lista.",
	// RI-63: el mismo texto que da la Main al editar una ficha que ya no está.
	trabajador_no_encontrado: "Ese trabajador ya no existe. Actualiza la lista.",
	comanda_has_paid_lines: "No se puede borrar: el ticket tiene líneas cobradas.",
	no_valid_pending_details: "Esas líneas ya no están pendientes de cobro. Actualiza el ticket.",
	invalid_or_paid_details: "Esas líneas ya no están pendientes de cobro. Actualiza la comanda.",
	caja_solo_en_main: "La caja sólo se gestiona desde el TPV principal.",
	cobro_solo_en_main: "Los cobros sólo se hacen desde el TPV principal.",
	recuperacion_solo_en_main: SOLO_EN_LA_MAIN,
	reserva_solapada: "Ya existe una reserva en esa mesa para ese día y hora.",
	// RI-61: el mismo texto que da la Main.
	cliente_no_encontrado:
		"Ese cliente ya no existe. Vuelve a buscarlo o guarda la reserva sin cliente.",
	// RI-54: una pantalla con la carta de antes en caché ofrece un producto que ya se quitó.
	producto_archivado: "Ese producto ya no está en la carta. Vuelve a abrir la carta y elige otro.",
	producto_en_comanda_abierta:
		"No se puede borrar: el producto está en una comanda abierta. Cóbrala o quita la línea y vuelve a intentarlo.",
	// RI-55: un ajuste de existencias que llega tarde. La ruta lo acompaña de lo que hay ahora.
	stock_cambiado:
		"Las existencias han cambiado mientras las ajustabas. Revísalas y vuelve a ajustar.",
	image_too_large: "La imagen es demasiado grande.",
	empty_body: "La imagen está vacía.",
	idempotency_operation_processing:
		"La operación anterior todavía se está guardando. Espera un momento y vuelve a intentarlo.",
	email_destino_no_autorizado: "Sólo se pueden mandar pedidos al correo de un proveedor dado de alta.",
	email_send_failed: "No se ha podido enviar el correo. Inténtalo más tarde.",
	email_limite_diario:
		"Se han mandado muchos pedidos por correo hoy desde este negocio. Vuelve a intentarlo mañana.",

	// Licencia, base de la nube y códigos por correo
	invalid_license_key_format: "La clave de licencia no tiene el formato correcto. Revísala.",
	device_change_required:
		"Esta licencia está activada en otro equipo. Para pasarla a éste hay que confirmar el cambio con el código enviado al correo de la compra.",
	device_key_mismatch:
		"La identidad de este equipo no coincide con la registrada para la licencia. Contacta con soporte.",
	tenant_db_provision_failed:
		"No se ha podido preparar la base de datos en la nube. Inténtalo de nuevo en unos minutos.",
	tenant_db_already_provisioned: "La base de datos de la nube ya existe.",
	invalid_code: "El código no es correcto.",
	code_expired: "El código ha caducado. Pide uno nuevo.",
	correo_invalido: "Ese correo no parece válido. Revísalo.",
	correo_no_enviado: "No se ha podido enviar el correo. Inténtalo más tarde.",
	demasiadas_solicitudes: "Se han pedido demasiados códigos. Espera un rato antes de pedir otro.",
	espera_reenvio: "Espera unos minutos antes de pedir otro código.",
	sin_correo: "La licencia no tiene un correo al que enviar el código.",
	// REV-13: se teclea un código que ya se usó. Lo normal es reintentar un canje que ya salió
	// bien (y los meses ya están sumados), así que el texto tiene que evitar que lo vuelva a
	// intentar creyendo que no se aplicó.
	license_already_used:
		"Ese código ya se ha usado. Si acabas de canjearlo, el tiempo ya está sumado a tu licencia.",
};

export const SIN_MENSAJE_PROPIO: ReadonlySet<string> = new Set([
	// Se traducen a un código de negocio y su texto genérico basta.
	"not_approved",
	"main_offline",
	"device_revoked",
	"device_replaced",
	"license_expired",
	"license_revoked",
	"license_not_found",
	"no_active_license_for_tenant",
	"tenant_db_not_provisioned",
	"bootstrap_demasiado_grande",
	"migration_altered",
	"validation_error",
	"not_found",
	"internal_error",
	// Internos: sólo salen si hay un bug, un cliente manipulado o una configuración rota.
	"admin_disabled",
	"interruptor_not_found",
	"unauthorized",
	"key_unavailable",
	"license_not_activated",
	"license_not_revoked",
	"bad_b64",
	"bad_b64_chars",
	"bad_device_ts",
	"bad_image_path",
	"bad_internal_signature",
	"bad_internal_ts",
	"bad_json",
	"bad_jwt_payload",
	"bad_jwt_signature",
	"bad_pubkey_len",
	"bad_signature_len",
	"bad_ts",
	"bad_ws_signature",
	"challenge_mismatch",
	"expired_ticket",
	"field_dek_no_persistida",
	"forbidden_event",
	"fulfillment_failed",
	"hello_failed",
	"idempotency_command_mismatch",
	"idempotency_payload_mismatch",
	"ingest_failed",
	"initial_admin_role_missing",
	"internal_secret_missing",
	"internal_ts_out_of_range",
	"invalid_devicePubKey",
	"invalid_json",
	"invalid_signature",
	"invalid_sql_args",
	"invalid_ticket",
	"invalid_transaction_step",
	"jwt_not_active",
	"malformed_signature",
	"missing_apply_fields",
	"missing_challenge",
	"missing_client_now",
	"missing_command_name",
	"missing_command_type",
	"missing_deviceId",
	"missing_devicePubKey",
	"missing_env_EMAIL_FROM_ADDRESS",
	"missing_env_LICENSE_JWT_SECRET",
	"missing_env_TURSO_AUTH_TOKEN",
	"missing_env_TURSO_DATABASE_URL",
	"missing_event_id",
	"missing_internal_auth",
	"missing_op_id",
	"missing_pairCode",
	"missing_proof",
	"missing_pubkey",
	"missing_session_id",
	"missing_signature",
	"missing_sql",
	"missing_tenant_id",
	"missing_ticket",
	"missing_transaction_steps",
	"missing_webhook_secret",
	"no_session",
	"not_authenticated",
	"pair_code_generation_failed",
	"payload_too_large",
	"reversal_failed",
	"signature_timestamp_out_of_range",
	"tabla_no_paginable",
	"ts_out_of_range",
	"unknown_type",
	"unsupported_sql_arg",
]);

/**
 * El identificador sin lo que algunos llevan detrás (`insufficient_stock:12:3:1`,
 * `escritura_solo_en_main:Pagos`), normalizado igual que en `wireToCode`.
 */
export function claveDeError(error: string): string {
	return String(error ?? "")
		.split(":")[0]
		.trim()
		.toLowerCase();
}

function textoNoVacio(valor: unknown): valor is string {
	return typeof valor === "string" && valor.trim() !== "";
}

/**
 * Completa el cuerpo de una respuesta de error: que lleve un `code` del catálogo y, si su
 * identificador tiene frase, `message`. Lo que la respuesta ya traía se respeta. Devuelve el MISMO
 * objeto si no hay nada que añadir, para que quien llama sepa que no tiene que reescribirla.
 */
export function completarCuerpoDeError(
	cuerpo: Record<string, unknown>,
	status: number,
): Record<string, unknown> {
	const error = typeof cuerpo.error === "string" ? cuerpo.error : "";
	const faltaCodigo = !esCodigoDelCatalogo(cuerpo.code);
	const mensaje = textoNoVacio(cuerpo.message) ? undefined : propia(MENSAJES, claveDeError(error));

	if (!faltaCodigo && !mensaje) return cuerpo;

	return {
		...cuerpo,
		...(faltaCodigo ? { code: wireToCode(error, status) } : {}),
		...(mensaje ? { message: mensaje } : {}),
	};
}
