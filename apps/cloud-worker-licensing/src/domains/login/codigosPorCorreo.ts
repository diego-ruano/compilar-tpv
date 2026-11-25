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
//     quien la hace cumplir es esto. Y como el intento, el envío se RESERVA en una sola sentencia
//     (AUD-42): leer, decidir y escribir después dejaba pasar a todas las peticiones simultáneas.
//   · La espera cuenta desde un envío que ha SALIDO (CORREO-CONFIRMAR). Mientras sale, sólo frena lo
//     que puede tardar un envío (`ENVIO_EN_VUELO_MS`), y quien lo manda dice después que ha salido
//     (`codigoEnviado`): una reserva cuyo correo no sale, o cuya respuesta se pierde, no deja a nadie
//     cinco minutos con «Acabamos de enviarte un código» sin que haya salido ninguno.

import type { Base } from "../../lib/sql";
import { recortar } from "../../lib/texto";

import type { Env } from "../../env";
import { hmacSha256Hex } from "../../server/utils/hmac";
import { timingSafeEqualHex } from "../../server/utils/crypto";
import { capturarError } from "../../observability/errors";
import {
	consumeEmailCode,
	getEmailCode,
	markEmailCodeSent,
	reserveEmailCodeAttempt,
	reserveEmailCodeSend,
	voidEmailCode,
	type EmailCodeKey,
	type EmailCodeRow,
} from "../../server/licenseStore";
import { generateOtpCode, OTP_MAX_ATTEMPTS, OTP_TTL_MS } from "../licensing/licensing.helpers";

/** Entre dos envíos del mismo equipo y propósito. El código dura el doble, así que da tiempo. */
export const REENVIO_MIN_MS = 5 * 60_000;
/**
 * Lo que frena un código reservado cuyo correo aún no ha dicho que ha salido: más de lo que tarda un
 * envío, para que las peticiones a la vez no manden cada una el suyo (AUD-42).
 */
const ENVIO_EN_VUELO_MS = 60_000;
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
		[k.purpose, k.tenantId, k.deviceId, sujeto, recortar(codigo)].join("\n"),
	);
}

function sinSecreto(env: Env): RespuestaCodigo | null {
	// Con la clave vacía el HMAC se calcularía igual y cuadraría: fallar cerrado.
	if (recortar(String(env.LICENSE_JWT_SECRET ?? ""))) return null;
	return fallo(500, "missing_env_LICENSE_JWT_SECRET", "Error de configuración del servidor.", "internal");
}

export type CodigoEmitido =
	| { ok: true; codigo: string; minutos: number; reenvioSegundos: number; huella: string }
	| { ok: false; respuesta: RespuestaCodigo };

/**
 * Genera y guarda un código para `sujeto`. No lo envía: quien llama sabe a dónde y con qué texto.
 * Si el envío sale, llama a `codigoEnviado` (desde ahí cuenta la espera); si falla, a `anularCodigo`
 * para que no quede uno vivo.
 */
export async function emitirCodigo(
	db: Base,
	env: Env,
	k: EmailCodeKey,
	sujeto: string,
	ahora: number,
): Promise<CodigoEmitido> {
	const mal = sinSecreto(env);
	if (mal) return { ok: false, respuesta: mal };

	// AUD-42: la espera y el tope se deciden en la misma sentencia que guarda el código. Si no toca,
	// no se escribe nada y no se envía; la lectura de después sólo elige qué decirle.
	const codigo = generateOtpCode();
	const codeHash = await huella(env, k, sujeto, codigo);
	const reservado = await reserveEmailCodeSend(db, {
		...k,
		subject: sujeto,
		codeHash,
		expiresAtMs: ahora + OTP_TTL_MS,
		nowMs: ahora,
		esperaMs: REENVIO_MIN_MS,
		enVueloMs: ENVIO_EN_VUELO_MS,
		ventanaMs: VENTANA_ENVIOS_MS,
		maxEnvios: MAX_ENVIOS_POR_VENTANA,
	});
	if (!reservado) return { ok: false, respuesta: porQueNoSeEnvia(await getEmailCode(db, k), ahora) };

	return {
		ok: true,
		codigo,
		minutos: Math.round(OTP_TTL_MS / 60_000),
		reenvioSegundos: Math.round(REENVIO_MIN_MS / 1000),
		huella: codeHash,
	};
}

/**
 * El correo del código ha salido: la espera hasta el siguiente cuenta desde ahora (CORREO-CONFIRMAR).
 * No lanza: el código ya está en el buzón y vale igual; si no se puede apuntar, la espera se queda en
 * la de un envío en vuelo (`ENVIO_EN_VUELO_MS`), y el tope por hora sigue contando.
 */
export async function codigoEnviado(
	db: Base,
	k: EmailCodeKey,
	emitido: { huella: string },
	ahora: number,
): Promise<void> {
	try {
		await markEmailCodeSent(db, k, emitido.huella, ahora);
	} catch (e) {
		capturarError(e, "codigos_por_correo.enviado");
	}
}

/** Por qué no toca enviar otro código, con la cuenta atrás si es la espera. */
function porQueNoSeEnvia(previo: EmailCodeRow | null, ahora: number): RespuestaCodigo {
	const ventanaViva = !!previo && ahora - previo.window_started_ms < VENTANA_ENVIOS_MS;
	const enEspera = !!previo && !previo.consumed_at_ms && ahora - previo.created_at_ms < REENVIO_MIN_MS;
	if (previo && ventanaViva && previo.sends_in_window >= MAX_ENVIOS_POR_VENTANA && !enEspera) {
		return fallo(429, "demasiadas_solicitudes", "Se han pedido demasiados códigos. Vuelve a intentarlo dentro de una hora.");
	}
	// La espera, o lo que haya cambiado entre la reserva y esta lectura: la cuenta atrás entera.
	const transcurrido = enEspera ? ahora - previo!.created_at_ms : 0;
	const minutos = Math.max(1, Math.ceil((REENVIO_MIN_MS - transcurrido) / 60_000));
	return fallo(
		429,
		"espera_reenvio",
		`Acabamos de enviarte un código. Podrás pedir otro en ${minutos} ${minutos === 1 ? "minuto" : "minutos"}.`,
	);
}

/**
 * El código no llegó a nadie: se anula para que no quede uno vivo. Al anularlo deja de contar la
 * espera entre códigos (`REENVIO_MIN_MS`, cinco minutos); el envío fallido sí cuenta para el tope
 * por hora (`MAX_ENVIOS_POR_VENTANA`).
 */
export async function anularCodigo(db: Base, k: EmailCodeKey, ahora: number): Promise<void> {
	await voidEmailCode(db, k, ahora);
}

export type CodigoComprobado =
	| { ok: true; sujeto: string }
	| { ok: false; respuesta: RespuestaCodigo };

/** El código no existe, ya se usó, o lo ha usado otra petición a la vez. */
export function codigoNoValido(): RespuestaCodigo {
	return fallo(400, "invalid_code", "Este código no es válido. Pide uno nuevo.");
}

/**
 * Comprueba y, si vale, CONSUME el código. `sujetoEsperado` es para cuando quien llama ya sabe a
 * qué se refiere (el usuario del PIN); si no se da, se devuelve el guardado (la dirección nueva).
 */
export async function comprobarCodigo(
	db: Base,
	env: Env,
	k: EmailCodeKey,
	codigoEscrito: string,
	ahora: number,
	sujetoEsperado?: string,
): Promise<CodigoComprobado> {
	const comprobado = await comprobarSinGastar(db, env, k, codigoEscrito, ahora, sujetoEsperado);
	if (!comprobado.ok) return comprobado;

	// Consumo atómico: de dos peticiones con el código bueno a la vez, sólo una gana.
	if (!(await consumeEmailCode(db, k, ahora))) return { ok: false, respuesta: codigoNoValido() };

	return { ok: true, sujeto: comprobado.sujeto };
}

/**
 * Comprueba el código sin gastarlo: lo gasta quien llama, en el mismo lote que lo que el código
 * autoriza (CORREO-CONFIRMAR), con `huella`, la del código comprobado. El intento sí queda contado.
 *
 * Si el código ya está gastado pero es éste y no ha caducado, lo dice en `yaGastado` (con su sujeto
 * y cuándo se gastó), para que quien llama reconozca el reintento de un lote que entró y cuya
 * respuesta se perdió. La respuesta sigue siendo que el código no vale: reconocerlo es cosa suya.
 */
export async function comprobarSinGastar(
	db: Base,
	env: Env,
	k: EmailCodeKey,
	codigoEscrito: string,
	ahora: number,
	sujetoEsperado?: string,
): Promise<
	| { ok: true; sujeto: string; huella: string }
	| { ok: false; respuesta: RespuestaCodigo; yaGastado?: { sujeto: string; gastadoEnMs: number } }
> {
	const mal = sinSecreto(env);
	if (mal) return { ok: false, respuesta: mal };

	const codigo = recortar(codigoEscrito);
	if (!/^\d{6}$/.test(codigo)) {
		return { ok: false, respuesta: fallo(400, "invalid_code", "El código son 6 cifras.") };
	}

	const invalido = { ok: false as const, respuesta: codigoNoValido() };

	const fila = await getEmailCode(db, k);
	if (!fila) return invalido;
	if (fila.consumed_at_ms) {
		const esEste =
			ahora <= fila.expires_at_ms &&
			(sujetoEsperado === undefined || fila.subject === sujetoEsperado) &&
			timingSafeEqualHex(await huella(env, k, fila.subject, codigo), fila.code_hash);
		return esEste
			? { ...invalido, yaGastado: { sujeto: fila.subject, gastadoEnMs: fila.consumed_at_ms } }
			: invalido;
	}
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

	return { ok: true, sujeto: fila.subject, huella: fila.code_hash };
}
