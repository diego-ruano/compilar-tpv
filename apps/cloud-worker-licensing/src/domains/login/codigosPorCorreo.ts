// src/domains/login/codigosPorCorreo.ts
//
// Códigos de 6 cifras que se mandan por correo desde una ruta de tenant y se escriben en el TPV.
// Hoy los usan dos cosas: recuperar el PIN de un administrador (LOGIN-07) y confirmar un correo de
// recuperación nuevo (LOGIN-08). Las reglas son las mismas, así que viven una sola vez aquí; quien
// los usa sólo decide a quién se manda y qué pasa cuando el código vale.
//
// Por qué así, para no deshacerlo sin querer:
//
//   · Un código por EQUIPO y PROPÓSITO, no por usuario ni por dirección. Pedir otro sustituye al
//     anterior. Si fuera por usuario o por dirección, recorrerlos multiplicaría el tope de envíos.
//   · Se guarda un HMAC con un secreto del worker, atado a propósito + tenant + equipo + sujeto.
//     Seis cifras son un millón de combinaciones: un SHA-256 a pelo se revierte en segundos con un
//     volcado de la base central. Y como el propósito entra en la huella, un código de cambio de
//     correo no vale para cambiar un PIN, ni al revés.
//   · El intento se RESERVA antes de comparar, en una sola sentencia. Comprobar el contador y
//     sumarlo después dejaría pasar a la vez a todas las peticiones concurrentes.
//   · Cinco minutos entre envíos y un tope por hora: el botón no puede ser un cañón contra un buzón.
//     La espera viaja en la respuesta (`reenvioSegundos`) para que la pantalla cuente atrás, pero
//     quien la hace cumplir es esto.

import type { Client } from "@libsql/client/web";

import type { Env } from "../../env";
import { hmacSha256Hex } from "../../server/utils/hmac";
import { timingSafeEqualHex } from "../../server/utils/crypto";
import {
	consumeEmailCode,
	getEmailCode,
	putEmailCode,
	reserveEmailCodeAttempt,
	voidEmailCode,
	type EmailCodeKey,
} from "../../server/licenseStore";
import { generateOtpCode, OTP_MAX_ATTEMPTS, OTP_TTL_MS } from "../licensing/licensing.helpers";

/** Entre dos envíos del mismo equipo y propósito. El código dura el doble, así que da tiempo. */
export const REENVIO_MIN_MS = 5 * 60_000;
/** Tope de envíos por equipo y propósito dentro de esta ventana, se usen o no. */
export const VENTANA_ENVIOS_MS = 60 * 60_000;
export const MAX_ENVIOS_POR_VENTANA = 5;

export type RespuestaCodigo = {
	status: 200 | 400 | 404 | 429 | 500 | 502;
	body: Record<string, unknown>;
};

/**
 * `message` es lo que ve quien está delante del TPV (el cliente Rust lo usa tal cual), y `code`
 * es del catálogo compartido: ninguno de estos casos pide a la pantalla hacer algo distinto de
 * enseñarlo, así que van con el genérico.
 */
export function fallo(
	status: RespuestaCodigo["status"],
	error: string,
	message: string,
	code = "validation",
): RespuestaCodigo {
	return { status, body: { ok: false, code, error, message } };
}

async function huella(env: Env, k: EmailCodeKey, sujeto: string, codigo: string): Promise<string> {
	return hmacSha256Hex(
		env.LICENSE_JWT_SECRET,
		[k.purpose, k.tenantId, k.deviceId, sujeto, codigo.trim()].join("\n"),
	);
}

function sinSecreto(env: Env): RespuestaCodigo | null {
	// Con la clave vacía el HMAC se calcularía igual y cuadraría: fallar cerrado.
	if (String(env.LICENSE_JWT_SECRET ?? "").trim()) return null;
	return fallo(500, "missing_env_LICENSE_JWT_SECRET", "Error de configuración del servidor.", "internal");
}

export type CodigoEmitido =
	| { ok: true; codigo: string; minutos: number; reenvioSegundos: number }
	| { ok: false; respuesta: RespuestaCodigo };

/**
 * Genera y guarda un código para `sujeto`. No lo envía: quien llama sabe a dónde y con qué texto,
 * y si el envío falla tiene que llamar a `anularCodigo` para que no quede uno vivo.
 */
export async function emitirCodigo(
	db: Client,
	env: Env,
	k: EmailCodeKey,
	sujeto: string,
	ahora: number,
): Promise<CodigoEmitido> {
	const mal = sinSecreto(env);
	if (mal) return { ok: false, respuesta: mal };

	const previo = await getEmailCode(db, k);

	if (previo && !previo.consumed_at_ms && ahora - previo.created_at_ms < REENVIO_MIN_MS) {
		const minutos = Math.ceil((REENVIO_MIN_MS - (ahora - previo.created_at_ms)) / 60_000);
		return {
			ok: false,
			respuesta: fallo(
				429,
				"espera_reenvio",
				`Acabamos de enviarte un código. Podrás pedir otro en ${minutos} ${minutos === 1 ? "minuto" : "minutos"}.`,
			),
		};
	}

	const ventanaViva = !!previo && ahora - previo.window_started_ms < VENTANA_ENVIOS_MS;
	if (previo && ventanaViva && previo.sends_in_window >= MAX_ENVIOS_POR_VENTANA) {
		return {
			ok: false,
			respuesta: fallo(
				429,
				"demasiadas_solicitudes",
				"Se han pedido demasiados códigos. Vuelve a intentarlo dentro de una hora.",
			),
		};
	}

	const codigo = generateOtpCode();
	await putEmailCode(db, {
		...k,
		subject: sujeto,
		codeHash: await huella(env, k, sujeto, codigo),
		expiresAtMs: ahora + OTP_TTL_MS,
		nowMs: ahora,
		sendsInWindow: previo && ventanaViva ? previo.sends_in_window + 1 : 1,
		windowStartedMs: previo && ventanaViva ? previo.window_started_ms : ahora,
	});

	return {
		ok: true,
		codigo,
		minutos: Math.round(OTP_TTL_MS / 60_000),
		reenvioSegundos: Math.round(REENVIO_MIN_MS / 1000),
	};
}

/**
 * El código no llegó a nadie: se anula para que no quede uno vivo. Al anularlo deja de contar la
 * espera de un minuto (el envío fallido sí cuenta para el tope por hora).
 */
export async function anularCodigo(db: Client, k: EmailCodeKey, ahora: number): Promise<void> {
	await voidEmailCode(db, k, ahora);
}

export type CodigoComprobado =
	| { ok: true; sujeto: string }
	| { ok: false; respuesta: RespuestaCodigo };

/**
 * Comprueba y, si vale, CONSUME el código. `sujetoEsperado` es para cuando quien llama ya sabe a
 * qué se refiere (el usuario del PIN); si no se da, se devuelve el guardado (la dirección nueva).
 */
export async function comprobarCodigo(
	db: Client,
	env: Env,
	k: EmailCodeKey,
	codigoEscrito: string,
	ahora: number,
	sujetoEsperado?: string,
): Promise<CodigoComprobado> {
	const mal = sinSecreto(env);
	if (mal) return { ok: false, respuesta: mal };

	const codigo = codigoEscrito.trim();
	if (!/^\d{6}$/.test(codigo)) {
		return { ok: false, respuesta: fallo(400, "invalid_code", "El código son 6 cifras.") };
	}

	const invalido = {
		ok: false as const,
		respuesta: fallo(400, "invalid_code", "Este código no es válido. Pide uno nuevo."),
	};

	const fila = await getEmailCode(db, k);
	if (!fila || fila.consumed_at_ms) return invalido;
	if (sujetoEsperado !== undefined && fila.subject !== sujetoEsperado) return invalido;
	if (ahora > fila.expires_at_ms) {
		return { ok: false, respuesta: fallo(400, "code_expired", "El código ha caducado. Pide uno nuevo.") };
	}

	const intento = await reserveEmailCodeAttempt(db, k, OTP_MAX_ATTEMPTS);
	if (intento === null) {
		return {
			ok: false,
			respuesta: fallo(429, "too_many_attempts", "Demasiados intentos con este código. Pide uno nuevo."),
		};
	}

	if (!timingSafeEqualHex(await huella(env, k, fila.subject, codigo), fila.code_hash)) {
		const quedan = OTP_MAX_ATTEMPTS - intento;
		return {
			ok: false,
			respuesta: fallo(
				400,
				"invalid_code",
				quedan > 0
					? `El código no es correcto. Te quedan ${quedan} ${quedan === 1 ? "intento" : "intentos"}.`
					: "El código no es correcto. Pide uno nuevo.",
			),
		};
	}

	// Consumo atómico: de dos peticiones con el código bueno a la vez, sólo una gana.
	if (!(await consumeEmailCode(db, k, ahora))) return invalido;

	return { ok: true, sujeto: fila.subject };
}
