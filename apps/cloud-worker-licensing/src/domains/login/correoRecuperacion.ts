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

import type { Client } from "@libsql/client/web";
import { recortar } from "../../lib/texto";

import type { Env } from "../../env";
import {
	getLicenseByHash,
	getTenantRecoveryEmail,
	setTenantRecoveryEmail,
	type EmailCodeKey,
	type LicenseRow,
} from "../../server/licenseStore";
import {
	sendRecoveryEmailChangedNoticeEmail,
	sendRecoveryEmailCodeEmail,
} from "../licensing/licenseEmails";
import { emailHint } from "../licensing/licensing.helpers";
import {
	anularCodigo,
	comprobarCodigo,
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
export async function correoDeRecuperacion(db: Client, lic: LicenseRow): Promise<string> {
	const propio = lic.tenant_id ? await getTenantRecoveryEmail(db, lic.tenant_id) : null;
	return recortar(propio ?? lic.customer_email ?? "");
}

function normalizar(correo: unknown): string {
	return recortar(String(correo ?? "")).toLowerCase();
}

function pareceCorreo(correo: string): boolean {
	return correo.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo);
}

function clave(ctx: ContextoCorreo): EmailCodeKey {
	return { tenantId: ctx.tenantId, deviceId: ctx.deviceId, purpose: "cambio_correo" };
}

async function licenciaDelTenant(
	db: Client,
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

async function estado(db: Client, lic: LicenseRow): Promise<RespuestaCodigo> {
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
	db: Client,
	ctx: ContextoCorreo,
): Promise<RespuestaCodigo> {
	const l = await licenciaDelTenant(db, ctx);
	if (!l.ok) return l.respuesta;
	return estado(db, l.lic);
}

export async function solicitarCambioCorreo(
	db: Client,
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
	db: Client,
	env: Env,
	ctx: ContextoCorreo & { codigo: string },
	diferir: (p: Promise<unknown>) => void,
): Promise<RespuestaCodigo> {
	const l = await licenciaDelTenant(db, ctx);
	if (!l.ok) return l.respuesta;

	// Sin sujeto esperado: el código lleva guardada la dirección que se pidió, y es ésa —no una que
	// llegue ahora en el cuerpo— la que queda confirmada.
	const comprobado = await comprobarCodigo(db, env, clave(ctx), ctx.codigo, ctx.ahora);
	if (!comprobado.ok) return comprobado.respuesta;

	const nuevo = normalizar(comprobado.sujeto);
	const anterior = await correoDeRecuperacion(db, l.lic);
	const compra = normalizar(l.lic.customer_email);

	await setTenantRecoveryEmail(db, ctx.tenantId, nuevo === compra ? null : nuevo, ctx.ahora);
	avisarDelCambio(env, diferir, [anterior, l.lic.customer_email], nuevo);

	return estado(db, l.lic);
}

export async function usarCorreoDeLaCompra(
	db: Client,
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
