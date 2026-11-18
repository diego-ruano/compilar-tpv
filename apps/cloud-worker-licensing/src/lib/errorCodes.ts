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
	reserva_solapada: "reserva_solapada",
	usuario_inactivo: "usuario_inactivo",
	// FISCAL-01: la Handy no cobra, así que no emite registros — pero el veto de
	// `applyViaHub` sí sale por aquí si alguna ruta futura lo intenta.
	escritura_solo_en_main: "permiso_denegado",
	validation_error: "validation",
	not_found: "not_found",
};

/**
 * Lo que sale con un 5xx y NO es un fallo del programa: la nube no puede atender a este negocio
 * ahora mismo. Para quien lo recibe es `external` (la gravedad «entorno» del cliente), no
 * `internal`: no hay nada que arreglar en el equipo, y quien tiene que enterarse ya se entera en la
 * nube. En Rust caen en `External` por la misma vía, la de lo que `from_wire` no conoce.
 */
const NUBE_NO_DISPONIBLE: ReadonlySet<string> = new Set([
	// La base del negocio no ha podido ponerse al día tras un despliegue (`MotorTenantHub.getTenantDb`).
	"tenant_db_migration_failed",
	// El objeto del negocio está saturado o no ha podido atender la petición (`lib/enElHub.ts`).
	"hub_overloaded",
	"hub_unavailable",
	// AUD-02: el TenantHub no ha podido preguntar a la base central si este equipo sigue siendo la
	// Main (`MotorTenantHub.vetoDeMain`).
	"main_sin_comprobar",
	// DO-PERDIDA: el negocio ya nació y su base no está en su TenantHub (`lib/basePerdida.ts`). No
	// es `tenant_db_not_provisioned`, que es con lo que la Main ofrece crear una base vacía.
	"tenant_db_perdida",
]);

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
 * Los códigos ad-hoc que nadie ramifica (`id_mesa_invalido`, `missing_tenant_id`…) caen
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

	return propia(NEGOCIO, clave) ?? (NUBE_NO_DISPONIBLE.has(clave) ? "external" : porEstado(status));
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
	reserva_solapada: true,
	usuario_inactivo: true,
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
	permiso_denegado: "No tienes permiso para esta acción.",
	// El mismo texto que la Main (`tpv_contracts::errors::USUARIO_INACTIVO`).
	usuario_inactivo: "Tu usuario ya no está activo. Habla con un administrador.",
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
	horario_solapado: "Ese horario se solapa con otro tramo del trabajador. Corrige las horas antes de guardar.",
	horario_editar_conjunto: "Edita los dos tramos del horario como un conjunto.",
	horario_invalido: "El horario contiene una fecha o unas horas inválidas.",
	asignacion_no_encontrada: "Asignación no encontrada.",
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
	// AUD-24: el PIN elegido en la configuración inicial de la Main aún no ha llegado a la nube.
	setup_inicial_pendiente: "Termina la configuración inicial en el TPV y vuelve a intentarlo.",
	// RI-61: la ruta manda su propia frase con las horas del choque; ésta es la de reserva.
	reserva_solapada: "Esa mesa ya está ocupada a esa hora.",
	reserva_solapada_prohibida:
		"Esa mesa ya está ocupada a esa hora, y en este negocio no se pueden solapar reservas.",
	// Borrar y cancelar una reserva (docs/estudios/reservas-web.md §5.6): el mismo texto que da la
	// Main (`MSG_WEB_NO_SE_BORRA`, `MSG_NO_PENDIENTE`).
	reserva_web_no_se_borra:
		"Una reserva hecha desde la web no se borra: se queda en la lista. Si aún no ha llegado, cancélala.",
	reserva_no_pendiente:
		"Esa reserva ya no se puede cancelar: el cliente ya ha llegado o la reserva ya está cerrada.",
	// El mismo texto que da la Main (`MSG_RESERVA_CAMBIADA`).
	reserva_cambiada:
		"Esa reserva ha cambiado mientras tanto: se ha cancelado, se ha marcado «No vino» o ya se ha cerrado. Cierra la mesa y vuelve a abrirla.",
	// RI-61: el mismo texto que da la Main.
	cliente_no_encontrado:
		"Ese cliente ya no existe. Vuelve a buscarlo o guarda la reserva sin cliente.",
	// AUD-26: el mismo texto que da la Main (`NO_ESTA_EN_TU_LISTA`): no va dirigida a ti, o ya no
	// está donde estaba (otro la restauró, la descartó o la borró).
	notificacion_no_encontrada: "Esa notificación no está en tu lista.",
	// RI-54: una pantalla con la carta de antes en caché ofrece un producto que ya se quitó.
	producto_archivado: "Ese producto ya no está en la carta. Vuelve a abrir la carta y elige otro.",
	// INC-20261030-010: el mismo texto que da la Main (`MSG_TAREA_NO_ASIGNADA`).
	tarea_no_asignada: "Esa tarea ya no está asignada a ti. Actualiza la lista.",
	// INC-20261030-016: el mismo texto que da la Main (`COMANDA_COBRADA`).
	comanda_cobrada:
		"Esa cuenta ya no está abierta: se ha cobrado o cerrado. Ciérrala y vuelve a abrir la mesa o un ticket nuevo.",
	// RES-INC-03: el mismo texto que la Main (`MSG_RESERVA_CAMBIADA_AL_EDITAR`).
	reserva_cambiada_al_editar:
		"Esta reserva ha cambiado en otro equipo mientras la editabas. Cierra el formulario y vuelve a abrirla.",
	// SYN-INC-04: el mismo texto que la Main (`MSG_RESERVA_CERRADA`).
	reserva_cerrada:
		"Esa reserva ya está cerrada (cancelada, terminada o no vino): ya no se puede cambiar. Cierra el formulario.",
	// RES-04: la guarda; la ruta lo dice antes con la hora de la comanda (`choqueEnLaMesa`).
	mesa_con_comanda_hoy: "Esa mesa tiene una comanda abierta: hoy no se puede reservar. Elige otra mesa u otro día.",
	// INV-INC-03: el mismo texto que la Main (`MSG_CATEGORIA_REPETIDA`).
	categoria_repetida: "Ya hay una categoría con ese nombre.",
	// Ingredientes: los mismos textos que la Main (`tpv-infra-sqlite/src/ingredientes.rs`).
	categoria_ingrediente_repetida: "Ya hay una categoría de ingredientes con ese nombre.",
	ingrediente_repetido: "Ya hay un ingrediente con ese nombre en esa categoría.",
	categoria_ingrediente_no_existe:
		"Esa categoría de ingredientes ya no existe. Vuelve a abrir la lista de ingredientes.",
	producto_en_comanda_abierta:
		"No se puede borrar: el producto está en una comanda abierta. Cóbrala o quita la línea y vuelve a intentarlo.",
	// RI-55: un ajuste de existencias que llega tarde. La ruta lo acompaña de lo que hay ahora.
	stock_cambiado:
		"Las existencias han cambiado mientras las ajustabas. Revísalas y vuelve a ajustar.",
	image_too_large: "La imagen es demasiado grande.",
	empty_body: "La imagen está vacía.",
	idempotency_operation_processing:
		"La operación anterior todavía se está guardando. Espera un momento y vuelve a intentarlo.",
	clave_no_canjeable: "Esa clave no se puede añadir a este equipo.",
	email_destino_no_autorizado:
		"Sólo se pueden mandar pedidos al correo de un proveedor dado de alta. Guárdalo primero en la ficha del proveedor.",
	email_send_failed: "No se ha podido enviar el correo. Inténtalo más tarde.",
	email_contacto_incompleto: "Completa el nombre del negocio y un correo de contacto válido en Configuración antes de enviar pedidos.",
	sync_log_corrupto: "No se pueden recuperar los cambios: el registro de sincronización está dañado.",
	email_limite_diario:
		"Se han mandado muchos pedidos por correo hoy desde este negocio. Vuelve a intentarlo mañana.",
	// El mismo pedido está saliendo ahora mismo por otra petición (`id_envio`).
	email_en_curso: "El pedido se está enviando ahora mismo. Espera un momento y vuelve a intentarlo: no saldrá dos veces.",

	// Licencia, base de la nube y códigos por correo
	// LIC-INC-01: el mismo texto que la Main (`MSG_CLAVE_MAL_FORMADA`) y la pantalla
	// (`clave_licencia_casos.json`).
	invalid_license_key_format:
		"La clave de licencia no tiene el formato correcto: son 20 letras y números, como TPV-XXXXX-XXXXX-XXXXX-XXXXX. Revísala.",
	device_change_required:
		"Esta licencia está activada en otro equipo. Para pasarla a éste hay que confirmar el cambio con el código enviado al correo de la compra.",
	device_key_mismatch:
		"La identidad de este equipo no coincide con la registrada para la licencia. Contacta con soporte.",
	// AUD-01: el equipo dice ser de un negocio y la nube lo tiene registrado en otro. Abrir el TPV
	// comprueba la licencia, que es lo que devuelve su fila a su negocio si sigue siendo su Main.
	device_tenant_mismatch:
		"Este equipo consta en la nube en otro negocio. Cierra el TPV y vuelve a abrirlo para que compruebe su licencia; si sigue igual, contacta con soporte.",
	// AUD-01: la fila del equipo no tiene clave registrada con la que comparar la que presenta.
	device_key_missing:
		"Este equipo está registrado sin su clave de identidad y no se puede comprobar que es él. Contacta con soporte.",
	tenant_db_provision_failed:
		"No se ha podido preparar la base de datos en la nube. Inténtalo de nuevo en unos minutos.",
	tenant_db_already_provisioned: "La base de datos de la nube ya existe.",
	tenant_db_perdida:
		"La base de datos de este negocio no está en la nube, donde debería estar. En este equipo no se ha borrado nada. Contacta con soporte antes de hacer nada más.",
	tenant_db_migration_failed:
		"La base de datos de la nube no está disponible ahora mismo. Vuelve a intentarlo en unos minutos.",
	hub_overloaded:
		"La nube está atendiendo demasiadas peticiones de este negocio. Espera unos segundos y vuelve a intentarlo.",
	hub_unavailable: "La nube no ha podido atender la petición. Vuelve a intentarlo en unos segundos.",
	main_sin_comprobar:
		"La nube no ha podido comprobar la licencia de este equipo. Vuelve a intentarlo en unos segundos.",
	invalid_code: "El código no es correcto.",
	code_expired: "El código ha caducado. Pide uno nuevo.",
	correo_invalido: "Ese correo no parece válido. Revísalo.",
	correo_no_enviado: "No se ha podido enviar el correo. Inténtalo más tarde.",
	demasiadas_solicitudes: "Se han pedido demasiados códigos. Espera un rato antes de pedir otro.",
	espera_reenvio: "Espera unos minutos antes de pedir otro código.",
	sin_correo: "La licencia no tiene un correo al que enviar el código.",
	// REV-13, AUD-07: se teclea una clave que ya se canjeó. Si es el mismo equipo repitiendo un canje
	// que ya salió bien, la ruta se lo dice con su propia frase (`fraseDeClaveYaCanjeada`); ésta es
	// para quien la teclea en otro equipo, donde antes estrenaba un negocio nuevo.
	license_already_used:
		"Esa clave ya se ha sumado a otra licencia. Si era para otro local, contacta con soporte.",

	// Reserva desde la web: lo lee quien reserva, en el widget, que pinta `message` tal cual.
	// Sin detalles a propósito (domains/reservas_web/puerta.ts): el motivo queda en el log.
	reserva_web_no_disponible:
		"Ahora mismo no se puede reservar por internet en este restaurante. Llama para reservar.",
	verificacion_humana_fallida:
		"No hemos podido comprobar que no eres un robot. Recarga la página y vuelve a intentarlo.",
	reserva_web_demasiadas: "Demasiadas peticiones seguidas. Espera un minuto y vuelve a intentarlo.",
	reserva_web_cerrada: "Este restaurante no admite reservas por internet ahora mismo. Llama para reservar.",
	dia_no_reservable: "Ese día no se puede reservar por internet. Elige otro.",
	hora_fuera_de_franja: "A esa hora no se puede reservar. Elige una de las horas que se ofrecen.",
	mesa_no_disponible: "Esa mesa acaba de ocuparse. Elige otra de las que quedan libres.",
	// Con la mesa automática: lo que hay que cambiar es la hora o el día, no la mesa.
	sin_mesa_libre: "No quedan mesas libres para esas personas a esa hora. Prueba otra hora u otro día.",
	limite_reservas_correo:
		"Ya tienes muchas reservas activas con este correo. Cancela alguna o llama al restaurante.",
	tope_reservas_negocio:
		"Este restaurante ha recibido muchas reservas por internet hoy. Llama para reservar.",
	reserva_no_cancelable:
		"Esta reserva ya no se puede cancelar por internet. Si lo necesitas, llama al restaurante.",
	enlace_no_valido: "Este enlace no es válido o ha caducado.",
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
	// Reservas desde la web: el aviso al cliente de un cambio (`POST /v1/reservas-web/avisos`). Los
	// lee el job de la Main, que reintenta o descarta; no llegan a nadie.
	"reserva_inexistente",
	"reserva_no_web",
	"reserva_no_al_dia",
	"correo_en_curso",
	"aviso_superado",
	"agenda_no_disponible",
	// El id de un parámetro de ruta que llega en blanco (`parseId`). La Handy no lo manda nunca:
	// el caso de uso de la Main ya exige el id antes de llamar, con su frase (VALID-03).
	"id_asignacion_invalido",
	"id_categoria_invalido",
	"id_cierre_invalido",
	"id_cliente_invalido",
	"id_comanda_invalido",
	"id_detalle_invalido",
	"id_gasto_invalido",
	"id_ingrediente_invalido",
	"id_lote_invalido",
	"id_mesa_invalido",
	"id_notificacion_invalido",
	"id_pago_invalido",
	"id_producto_invalido",
	"id_proveedor_invalido",
	"id_reserva_invalido",
	"id_tarea_invalido",
	"id_trabajador_invalido",
	"id_usuario_invalido",
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
	"hora_no_determinista",
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
	"fulfillment_failed",
	"hello_failed",
	"idempotency_command_mismatch",
	"idempotency_payload_mismatch",
	"ingest_failed",
	"initial_admin_role_missing",
	"invalid_devicePubKey",
	"invalid_json",
	// AUD-32: una `X-Idempotency-Key` sin su forma. La Handy manda siempre un UUIDv7.
	"invalid_op_id",
	"invalid_signature",
	"invalid_sql_args",
	"invalid_ticket",
	"invalid_transaction_step",
	"jwt_not_active",
	"line_items_paginados",
	"malformed_signature",
	"missing_apply_fields",
	"missing_challenge",
	"missing_client_now",
	"missing_command_name",
	"missing_deviceId",
	"missing_devicePubKey",
	"missing_env_EMAIL_FROM_ADDRESS",
	"missing_env_EMAIL_RESERVAS_FROM_ADDRESS",
	"missing_env_LICENSE_JWT_SECRET",
	"missing_env_TURSO_AUTH_TOKEN",
	"missing_env_TURSO_DATABASE_URL",
	"missing_event_id",
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
	// DO-NEGOCIO: una llamada ha llegado al TenantHub de un negocio con el identificador de otro.
	"negocio_ajeno",
	"no_session",
	"not_authenticated",
	"pair_code_generation_failed",
	"payload_too_large",
	"reversal_failed",
	"signature_timestamp_out_of_range",
	"tabla_no_paginable",
	// El contraste con la nube: lo manda la Main con lo que le dio el resumen, así que sólo salen
	// con un cliente roto.
	"tabla_no_verificable",
	"cubos_no_validos",
	"cursor_no_valido",
	"claves_no_validas",
	// Retirar un negocio de pruebas: un id que no nombra la carpeta de imágenes de un negocio, y una
	// agenda de reservas web que no ha acabado a tiempo lo que tenía a medias.
	"tenant_id_invalido",
	"agenda_ocupada",
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
