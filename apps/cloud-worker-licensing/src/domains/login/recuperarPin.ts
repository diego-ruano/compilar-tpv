// src/domains/login/recuperarPin.ts
//
// Recuperar el PIN de un administrador por correo (LOGIN-07).
//
// Es un código de 6 dígitos que llega al correo de la licencia y se escribe EN EL TPV:
//
//   1. La Main pide el código (`/v1/login/recuperar-pin/solicitar`). El tenant sale del token
//      firmado —nunca del cuerpo— y el correo, de la licencia de ESE token.
//   2. La Main manda el código (`/v1/login/recuperar-pin/verificar`). Si vale se consume, y es la
//      Main quien escribe el PIN nuevo en su base local; de ahí sube por el outbox como cualquier
//      otra escritura.
//
// Por qué así, para no deshacerlo sin querer:
//
//   · El PIN nuevo NUNCA pasa por aquí. La nube sólo dice si el código vale. Si el PIN se fijara
//     arriba habría un sitio en internet desde el que cambiarlo, y tendría que bajar a una Main que
//     puede no estar conectada.
//   · Hacen falta DOS cosas a la vez: el buzón y estar delante de la Main, porque la petición va
//     firmada con la clave de ese equipo. Quien entre en el correo desde casa no puede hacer nada.
//   · No hay enlace, a propósito. Los filtros de correo (Outlook, antivirus) abren los enlaces antes
//     que la persona y gastarían uno de un solo uso; y un enlace se abre en cualquier sitio, que es
//     justo la segunda prueba que se perdería.
//   · Un código por EQUIPO, no por usuario: pedirlo para otro administrador sustituye al anterior.
//     Por usuario, recorrer ids multiplicaría el límite de envíos contra el buzón del titular.
//   · Se guarda un HMAC con un secreto del worker, atado a tenant + equipo + usuario. Seis cifras
//     son un millón de combinaciones: un SHA-256 a pelo se revierte en segundos con un volcado de
//     la base central.
//   · El intento se RESERVA antes de comparar, en una sola sentencia. Comprobar el contador y
//     sumarlo después dejaría que cien peticiones en paralelo pasaran todas el «quedan intentos».
//   · Quién es administrador lo decide la Main (su base local manda en el login) y el worker sólo
//     comprueba que quien pide ES una Main. El correo va siempre al titular de la licencia, así
//     que un id de usuario inventado sólo puede molestar al propio titular.

import type { Client } from "@libsql/client/web";

import type { Env } from "../../env";
import { hmacSha256Hex } from "../../lib/internalAuth";
import { timingSafeEqualHex } from "../../server/utils/crypto";
import {
	consumePinRecoveryCode,
	getLicenseByHash,
	getPinRecoveryCode,
	putPinRecoveryCode,
	reservePinRecoveryAttempt,
	voidPinRecoveryCode,
} from "../../server/licenseStore";
import { sendPinChangedNoticeEmail, sendPinRecoveryCodeEmail } from "../licensing/licenseEmails";
import {
	emailHint,
	generateOtpCode,
	OTP_MAX_ATTEMPTS,
	OTP_TTL_MS,
} from "../licensing/licensing.helpers";

/** Entre dos envíos al mismo equipo. Evita usar el botón como cañón de correo. */
export const REENVIO_MIN_MS = 60_000;
/** Tope de envíos por equipo dentro de esta ventana, se usen o no. */
export const VENTANA_ENVIOS_MS = 60 * 60_000;
export const MAX_ENVIOS_POR_VENTANA = 5;

export type ContextoRecuperacion = {
	tenantId: string;
	deviceId: string;
	/** Claim del token: identifica la licencia exacta de este equipo. */
	licHash: string;
	idUsuario: string;
	ahora: number;
};

export type RespuestaRecuperacion = {
	status: 200 | 400 | 404 | 429 | 500 | 502;
	body: Record<string, unknown>;
};

/**
 * `message` es lo que ve quien está delante del TPV (el cliente Rust lo usa tal cual), y `code`
 * es del catálogo compartido: ninguno de estos casos pide a la pantalla hacer algo distinto de
 * enseñarlo, así que van con el genérico.
 */
function fallo(
	status: RespuestaRecuperacion["status"],
	error: string,
	message: string,
	code = "validation",
): RespuestaRecuperacion {
	return { status, body: { ok: false, code, error, message } };
}

async function huella(env: Env, ctx: ContextoRecuperacion, codigo: string): Promise<string> {
	return hmacSha256Hex(
		env.LICENSE_JWT_SECRET,
		["recuperar-pin", ctx.tenantId, ctx.deviceId, ctx.idUsuario, codigo.trim()].join("\n"),
	);
}

function sinSecreto(env: Env): RespuestaRecuperacion | null {
	// Con la clave vacía el HMAC se calcularía igual y cuadraría: fallar cerrado.
	if (String(env.LICENSE_JWT_SECRET ?? "").trim()) return null;
	return fallo(500, "missing_env_LICENSE_JWT_SECRET", "Error de configuración del servidor.", "internal");
}

export async function solicitarCodigoPin(
	db: Client,
	env: Env,
	ctx: ContextoRecuperacion,
): Promise<RespuestaRecuperacion> {
	const mal = sinSecreto(env);
	if (mal) return mal;

	const lic = await getLicenseByHash(db, ctx.licHash);
	// La licencia tiene que ser la de este tenant: el token las ata, pero el correo de otro
	// negocio es lo último que se puede mandar por error.
	if (!lic || lic.tenant_id !== ctx.tenantId) {
		return fallo(404, "license_not_found", "No se encuentra la licencia de este equipo.", "license_not_found");
	}

	const correo = String(lic.customer_email ?? "").trim();
	if (!correo) {
		return fallo(404, "sin_correo", "La licencia no tiene un correo al que enviar el código.");
	}

	const previo = await getPinRecoveryCode(db, ctx.tenantId, ctx.deviceId);

	if (previo && !previo.consumed_at_ms && ctx.ahora - previo.created_at_ms < REENVIO_MIN_MS) {
		return fallo(
			429,
			"espera_reenvio",
			"Acabamos de enviarte un código. Espera un minuto antes de pedir otro.",
		);
	}

	const ventanaViva = !!previo && ctx.ahora - previo.window_started_ms < VENTANA_ENVIOS_MS;
	if (previo && ventanaViva && previo.sends_in_window >= MAX_ENVIOS_POR_VENTANA) {
		return fallo(
			429,
			"demasiadas_solicitudes",
			"Se han pedido demasiados códigos. Vuelve a intentarlo dentro de una hora.",
		);
	}

	const codigo = generateOtpCode();
	await putPinRecoveryCode(db, {
		tenantId: ctx.tenantId,
		deviceId: ctx.deviceId,
		idUsuario: ctx.idUsuario,
		codeHash: await huella(env, ctx, codigo),
		expiresAtMs: ctx.ahora + OTP_TTL_MS,
		nowMs: ctx.ahora,
		sendsInWindow: previo && ventanaViva ? previo.sends_in_window + 1 : 1,
		windowStartedMs: previo && ventanaViva ? previo.window_started_ms : ctx.ahora,
	});

	const minutos = Math.round(OTP_TTL_MS / 60_000);

	// Se espera al envío, a diferencia del cambio de equipo: aquí quien pide está autenticado,
	// así que no hay nada que esconder, y decirle «revisa tu correo» cuando no ha salido
	// ninguno le deja esperando algo que no va a llegar.
	const enviado = await sendPinRecoveryCodeEmail(env, { to: correo, code: codigo, minutes: minutos });
	if (!enviado) {
		// El código no ha llegado a nadie: se anula para que no quede uno vivo, y al anularlo deja
		// de contar la espera de un minuto (el envío fallido sí cuenta para el tope por hora).
		await voidPinRecoveryCode(db, ctx.tenantId, ctx.deviceId, ctx.ahora);
		return fallo(
			502,
			"correo_no_enviado",
			"No se ha podido enviar el correo. Inténtalo de nuevo en unos minutos.",
			"external",
		);
	}

	return { status: 200, body: { ok: true, emailHint: emailHint(correo), minutos } };
}

export async function verificarCodigoPin(
	db: Client,
	env: Env,
	ctx: ContextoRecuperacion & { codigo: string },
	/** Para el aviso al titular, que no puede retener la respuesta (`waitUntil` en la ruta). */
	diferir: (p: Promise<unknown>) => void,
): Promise<RespuestaRecuperacion> {
	const mal = sinSecreto(env);
	if (mal) return mal;

	const codigo = ctx.codigo.trim();
	if (!/^\d{6}$/.test(codigo)) {
		return fallo(400, "invalid_code", "El código son 6 cifras.");
	}

	const fila = await getPinRecoveryCode(db, ctx.tenantId, ctx.deviceId);
	if (!fila || fila.consumed_at_ms || fila.id_usuario !== ctx.idUsuario) {
		return fallo(400, "invalid_code", "Este código no es válido. Pide uno nuevo.");
	}
	if (ctx.ahora > fila.expires_at_ms) {
		return fallo(400, "code_expired", "El código ha caducado. Pide uno nuevo.");
	}

	const intento = await reservePinRecoveryAttempt(db, ctx.tenantId, ctx.deviceId, OTP_MAX_ATTEMPTS);
	if (intento === null) {
		return fallo(429, "too_many_attempts", "Demasiados intentos con este código. Pide uno nuevo.");
	}

	if (!timingSafeEqualHex(await huella(env, ctx, codigo), fila.code_hash)) {
		const quedan = OTP_MAX_ATTEMPTS - intento;
		return fallo(
			400,
			"invalid_code",
			quedan > 0
				? `El código no es correcto. Te quedan ${quedan} ${quedan === 1 ? "intento" : "intentos"}.`
				: "El código no es correcto. Pide uno nuevo.",
		);
	}

	// Consumo atómico: de dos peticiones con el código bueno a la vez, sólo una gana.
	if (!(await consumePinRecoveryCode(db, ctx.tenantId, ctx.deviceId, ctx.ahora))) {
		return fallo(400, "invalid_code", "Este código no es válido. Pide uno nuevo.");
	}

	// Aviso al titular: si no ha sido él, que se entere hoy. Es entrega, no autorización, así que
	// no retiene la respuesta ni la hace fallar.
	const lic = await getLicenseByHash(db, ctx.licHash);
	const correo = String(lic?.customer_email ?? "").trim();
	if (correo) diferir(sendPinChangedNoticeEmail(env, { to: correo }));

	return { status: 200, body: { ok: true } };
}
