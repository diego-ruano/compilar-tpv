// src/domains/login/correoRecuperacion.ts
//
// El correo de recuperación del negocio (LOGIN-08): a dónde llegan los códigos para recuperar el
// PIN de un administrador.
//
// Por qué así, para no deshacerlo sin querer:
//
//   · Por defecto es el de la COMPRA (`licenses.customer_email`), que ya está demostrado: le llegó
//     la clave. Sólo si alguien lo cambia se guarda otro, en `tenant_recovery_emails`; sin fila, el
//     de la compra. Si se cambia AL de la compra, se borra la fila en vez de copiarlo: así sigue al
//     de la compra si éste cambia algún día.
//   · Cambiarlo exige un código enviado al correo NUEVO: prueba que existe y que está bien escrito.
//     No se pide también un código al anterior, a propósito: el caso normal de cambiarlo es que el
//     dueño ya no tiene ese buzón, y exigirlo le dejaría sin salida.
//   · Lo que protege de un cambio malicioso es el AVISO, al correo anterior y al de la compra, con la
//     pista del nuevo. Si no ha sido el dueño, se entera ese mismo día.
//   · Sólo afecta a recuperar el PIN. El cambio de equipo sigue yendo al de la compra: si siguiera a
//     éste, quien sepa el PIN de un administrador podría cambiar el correo y llevarse la licencia a
//     su ordenador.
//   · Que quien lo cambia sea un administrador lo comprueba la Main (sesión, SEC-01): el worker no
//     conoce las sesiones. Por eso lo que de verdad cuenta aquí es el código y el aviso.

import type { Base } from "../../lib/sql";
import { recortar } from "../../lib/texto";

import type { Env } from "../../env";
import {
	consumeEmailCodeAndSetRecoveryEmail,
	getLicenseByHash,
	getTenantRecoveryEmail,
	getTenantRecoveryEmailVerificado,
	setTenantRecoveryEmail,
	type EmailCodeKey,
	type LicenseRow,
} from "../../server/licenseStore";
import {
	sendRecoveryEmailChangedNoticeEmail,
	sendRecoveryEmailCodeEmail,
} from "../licensing/licenseEmails";
import { emailHint } from "../licensing/licensing.helpers";
import { isValidEmail } from "../clientes/clientes.schemas";
import {
	anularCodigo,
	codigoEnviado,
	codigoNoValido,
	comprobarSinGastar,
	emitirCodigo,
	fallo,
	type RespuestaCodigo,
} from "./codigosPorCorreo";

export type ContextoCorreo = {
	tenantId: string;
	deviceId: string;
	/** Claim del token: identifica la licencia exacta de este equipo. */
	licHash: string;
	ahora: number;
};

/** A dónde van los códigos de recuperación de esta licencia ahora mismo. */
export async function correoDeRecuperacion(db: Base, lic: LicenseRow): Promise<string> {
	const propio = lic.tenant_id ? await getTenantRecoveryEmail(db, lic.tenant_id) : null;
	return recortar(propio ?? lic.customer_email ?? "");
}

function normalizar(correo: unknown): string {
	return recortar(String(correo ?? "")).toLowerCase();
}

/**
 * La regla de un correo, la misma que la Main (`validate_email_basic`) al pedir el cambio. La de
 * antes dejaba pasar una lista («a@b.es,c@d.es») o un nombre con la dirección entre ángulos (AUD-39).
 */
function pareceCorreo(correo: string): boolean {
	return isValidEmail(correo);
}

function clave(ctx: ContextoCorreo): EmailCodeKey {
	return { tenantId: ctx.tenantId, deviceId: ctx.deviceId, purpose: "cambio_correo" };
}

async function licenciaDelTenant(
	db: Base,
	ctx: ContextoCorreo,
): Promise<{ ok: true; lic: LicenseRow } | { ok: false; respuesta: RespuestaCodigo }> {
	const lic = await getLicenseByHash(db, ctx.licHash);
	if (!lic || lic.tenant_id !== ctx.tenantId) {
		return {
			ok: false,
			respuesta: fallo(
				404,
				"license_not_found",
				"No se encuentra la licencia de este equipo.",
				"license_not_found",
			),
		};
	}
	return { ok: true, lic };
}

async function estado(db: Base, lic: LicenseRow): Promise<RespuestaCodigo> {
	const propio = lic.tenant_id ? await getTenantRecoveryEmail(db, lic.tenant_id) : null;
	const correo = recortar(propio ?? lic.customer_email ?? "");
	return {
		status: 200,
		body: { ok: true, emailHint: emailHint(correo), esElDeLaCompra: !propio },
	};
}

/**
 * Avisa del cambio a cada dirección que deja de recibir los códigos, y al de la compra, sin repetir
 * y sin avisar al nuevo (que ya ha recibido su código). Es entrega, no autorización.
 */
function avisarDelCambio(
	env: Env,
	diferir: (p: Promise<unknown>) => void,
	destinos: string[],
	nuevo: string,
): void {
	const vistos = new Set<string>();
	for (const destino of destinos) {
		const d = normalizar(destino);
		if (!d || d === nuevo || vistos.has(d)) continue;
		vistos.add(d);
		diferir(sendRecoveryEmailChangedNoticeEmail(env, { to: d, nuevoHint: emailHint(nuevo) }));
	}
}

export async function estadoCorreoRecuperacion(
	db: Base,
	ctx: ContextoCorreo,
): Promise<RespuestaCodigo> {
	const l = await licenciaDelTenant(db, ctx);
	if (!l.ok) return l.respuesta;
	return estado(db, l.lic);
}

export async function solicitarCambioCorreo(
	db: Base,
	env: Env,
	ctx: ContextoCorreo & { correo: string },
): Promise<RespuestaCodigo> {
	const l = await licenciaDelTenant(db, ctx);
	if (!l.ok) return l.respuesta;

	const nuevo = normalizar(ctx.correo);
	if (!pareceCorreo(nuevo)) {
		return fallo(400, "correo_invalido", "Ese correo no parece válido. Revísalo.");
	}
	// Pedir el que ya es no es un error: no hay nada que demostrar, así que ni se manda código ni se
	// pide confirmar. Pasa sobre todo con el PIN inicial, cuando alguien desmarca «usar el de la
	// compra» y escribe justo ése.
	if (normalizar(await correoDeRecuperacion(db, l.lic)) === nuevo) {
		return {
			status: 200,
			body: { ok: true, sinCambios: true, emailHint: emailHint(nuevo), minutos: 0, reenvioSegundos: 0 },
		};
	}

	const emitido = await emitirCodigo(db, env, clave(ctx), nuevo, ctx.ahora);
	if (!emitido.ok) return emitido.respuesta;

	const enviado = await sendRecoveryEmailCodeEmail(env, {
		to: nuevo,
		code: emitido.codigo,
		minutes: emitido.minutos,
	});
	if (!enviado) {
		await anularCodigo(db, clave(ctx), ctx.ahora);
		return fallo(
			502,
			"correo_no_enviado",
			"No se ha podido enviar el correo. Revisa la dirección o inténtalo en unos minutos.",
			"external",
		);
	}
	await codigoEnviado(db, clave(ctx), emitido, ctx.ahora);

	return {
		status: 200,
		body: {
			ok: true,
			emailHint: emailHint(nuevo),
			minutos: emitido.minutos,
			reenvioSegundos: emitido.reenvioSegundos,
		},
	};
}

export async function confirmarCambioCorreo(
	db: Base,
	env: Env,
	ctx: ContextoCorreo & { codigo: string },
	diferir: (p: Promise<unknown>) => void,
): Promise<RespuestaCodigo> {
	const l = await licenciaDelTenant(db, ctx);
	if (!l.ok) return l.respuesta;

	// CORREO-CONFIRMAR · A quién avisar se lee ANTES de tocar el código, como al recuperar el PIN
	// (E7a-2): una lectura que falla no se lleva el código.
	const anterior = await correoDeRecuperacion(db, l.lic);

	// Sin sujeto esperado: el código lleva guardada la dirección que se pidió, y es ésa —no una que
	// llegue ahora en el cuerpo— la que queda confirmada.
	const comprobado = await comprobarSinGastar(db, env, clave(ctx), ctx.codigo, ctx.ahora);
	if (!comprobado.ok) {
		// CORREO-CONFIRMAR · El lote entró y su respuesta se perdió: el reintento trae el mismo código,
		// ya gastado. Es ése si el correo vigente es justo el que dejó su lote; entonces se contesta
		// como entonces y salen los avisos, que no llegaron a salir.
		const g = comprobado.yaGastado;
		if (!g || !(await esElCambioDeEseCodigo(db, l.lic, g))) return comprobado.respuesta;
		return cambiado(env, diferir, l.lic, anterior, normalizar(g.sujeto));
	}

	const nuevo = normalizar(comprobado.sujeto);

	// Gastar el código y cambiar el correo, en un solo lote: entran los dos o ninguno, y si no entra,
	// el mismo código vale al reintentar.
	const gastado = await consumeEmailCodeAndSetRecoveryEmail(db, clave(ctx), {
		codeHash: comprobado.huella,
		email: nuevo === normalizar(l.lic.customer_email) ? null : nuevo,
		nowMs: ctx.ahora,
	});
	if (!gastado) return codigoNoValido();
	return cambiado(env, diferir, l.lic, anterior, nuevo);
}

/**
 * Si el correo de recuperación vigente es el que dejó el lote de un código ya gastado: el propio,
 * con ese correo y verificado en el mismo instante en que se gastó el código; o, si el código era
 * el de la compra, ninguno propio.
 */
async function esElCambioDeEseCodigo(
	db: Base,
	lic: LicenseRow,
	g: { sujeto: string; gastadoEnMs: number },
): Promise<boolean> {
	if (!lic.tenant_id) return false;
	const nuevo = normalizar(g.sujeto);
	const propio = await getTenantRecoveryEmailVerificado(db, lic.tenant_id);
	if (nuevo === normalizar(lic.customer_email)) return propio === null;
	return propio !== null && normalizar(propio.email) === nuevo && propio.verifiedAtMs === g.gastadoEnMs;
}

/**
 * El correo ya ha cambiado a `nuevo`: avisa y contesta. Lo que ya se sabe, sin volver a leerlo: una
 * relectura que fallara contestaría un error con el correo ya cambiado.
 */
function cambiado(
	env: Env,
	diferir: (p: Promise<unknown>) => void,
	lic: LicenseRow,
	anterior: string,
	nuevo: string,
): RespuestaCodigo {
	const esElDeLaCompra = nuevo === normalizar(lic.customer_email);
	avisarDelCambio(env, diferir, [anterior, lic.customer_email], nuevo);
	return {
		status: 200,
		body: {
			ok: true,
			emailHint: emailHint(esElDeLaCompra ? recortar(lic.customer_email ?? "") : nuevo),
			esElDeLaCompra,
		},
	};
}

export async function usarCorreoDeLaCompra(
	db: Base,
	env: Env,
	ctx: ContextoCorreo,
	diferir: (p: Promise<unknown>) => void,
): Promise<RespuestaCodigo> {
	const l = await licenciaDelTenant(db, ctx);
	if (!l.ok) return l.respuesta;

	// Volver al de la compra no pide código: ese buzón ya está demostrado, y lo peor que puede hacer
	// alguien con esto es mandar los códigos al dueño.
	const propio = await getTenantRecoveryEmail(db, ctx.tenantId);
	if (propio) {
		await setTenantRecoveryEmail(db, ctx.tenantId, null, ctx.ahora);
		avisarDelCambio(env, diferir, [propio], normalizar(l.lic.customer_email));
	}

	return estado(db, l.lic);
}
