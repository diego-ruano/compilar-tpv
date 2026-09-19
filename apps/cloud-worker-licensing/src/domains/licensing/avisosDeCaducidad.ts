// src/domains/licensing/avisosDeCaducidad.ts
//
// «Tu licencia caduca pronto, renuévala aquí» (REV-13).
//
// Es la otra mitad de hacer explícita la renovación. Mientras renovar consistió en volver al mismo
// enlace de compra, el worker no tenía forma de saber si una compra era un alta o una renovación y
// lo adivinaba por el cliente de Stripe — de ahí que quien abría un segundo local pagara y no
// recibiera clave. Ahora la renovación tiene su propio Price (`metadata.intent = renewal`) y su
// propio enlace, que lleva dentro QUÉ licencia renueva. Este job es quien pone ese enlace en manos
// del cliente; sin él, el camino correcto existiría y no lo conocería nadie.
//
// Reglas:
//   · **Sin `RENEWAL_URL` no se manda nada.** Un aviso de caducidad sin enlace empuja al cliente
//     al enlace de compra normal, que le emitiría una clave nueva: exactamente el problema que
//     esto viene a quitar. Fallar callado es mejor que fallar enseñando el camino equivocado.
//   · **Un aviso por licencia y por ciclo**, el más urgente que le toque. Con dos peldaños
//     independientes, una licencia que entra al catálogo con 5 días por delante recibiría los dos
//     correos el mismo día.
//   · **Se marca ANTES de enviar y sólo se envía si se ganó la marca.** Dos ejecuciones cruzadas no
//     mandan dos correos. Si el envío falla se suelta la marca, para que el ciclo siguiente lo
//     reintente: un aviso que no ha salido no puede quedar contado como enviado.

import type { Env } from "../../env";
import type { Sql } from "../../server/db";
import {
	licenciasPorCaducar,
	marcarAvisoEnviado,
	olvidarAvisoEnviado,
	type LicenseRow,
} from "../../server/licenseStore";
import { sendLicenseExpiringEmail } from "./licenseEmails";

const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * Los peldaños, **de más urgente a menos**. El orden es lo que hace que `find` devuelva el que
 * toca: a una licencia a la que le quedan 5 días le aplica el de 7, no el de 30.
 *
 * Dos y no cinco a propósito: renovar es un trámite de un clic, y la escalera de Veri*factu ya
 * enseñó que un aviso que se repite mucho se aprende a descartar. El de 30 llega cuando renovar
 * todavía es cómodo; el de 7, cuando ya corre prisa.
 */
export const PELDANOS = [
	{ kind: "expira_7", dias: 7 },
	{ kind: "expira_30", dias: 30 },
] as const;

const DIAS_MAX = Math.max(...PELDANOS.map((p) => p.dias));

/**
 * El enlace de renovación de UNA licencia concreta.
 *
 * `RENEWAL_URL` es el Payment Link del Price de renovación (el que lleva `metadata.intent =
 * renewal`), y lo que se le añade aquí es el `client_reference_id`: el `license_id` que Stripe
 * devuelve intacto en la sesión y con el que el webhook sabe cuál alargar. Sin ese parámetro la
 * compra llegaría marcada como renovación y sin destino, y acabaría emitiendo una licencia nueva.
 *
 * `prefilled_email` es sólo comodidad — el dueño no tiene que teclear su correo—, pero además
 * ayuda a que Stripe reutilice el Customer que ya existe, que es lo que luego permite reconocer
 * el pago como suyo aunque el enlace se hubiera reenviado.
 */
export function enlaceDeRenovacion(env: Env, license: LicenseRow): string | null {
	const base = String(env.RENEWAL_URL || "").trim();
	if (!base) return null;

	try {
		const url = new URL(base);
		url.searchParams.set("client_reference_id", license.license_id);
		const correo = String(license.customer_email || "").trim();
		if (correo) url.searchParams.set("prefilled_email", correo);
		return url.toString();
	} catch {
		console.error("[avisos] RENEWAL_URL no es una URL válida:", base);
		return null;
	}
}

export type ResumenDeAvisos = {
	revisadas: number;
	enviados: number;
	yaAvisadas: number;
	fallidos: number;
	sinEnlace: boolean;
};

/**
 * Un ciclo completo. Lo llama el `scheduled` del worker una vez al día; es idempotente, así que
 * adelantarlo o repetirlo no manda nada de más.
 *
 * La conexión llega de fuera, como en `cumplir`: así el ciclo se prueba entero contra el esquema
 * real del control-plane sin salir a Turso.
 */
export async function avisarDeCaducidades(
	env: Env,
	db: Sql,
	ahoraMs = Date.now(),
): Promise<ResumenDeAvisos> {
	const resumen: ResumenDeAvisos = {
		revisadas: 0,
		enviados: 0,
		yaAvisadas: 0,
		fallidos: 0,
		sinEnlace: !String(env.RENEWAL_URL || "").trim(),
	};

	if (resumen.sinEnlace) {
		console.error("[avisos] falta RENEWAL_URL: no se avisa de ninguna caducidad");
		return resumen;
	}

	const candidatas = await licenciasPorCaducar(db, ahoraMs, ahoraMs + DIAS_MAX * DIA_MS);
	resumen.revisadas = candidatas.length;

	for (const license of candidatas) {
		const expiresAtMs = Number(license.expires_at_ms);
		const restanteMs = expiresAtMs - ahoraMs;
		const peldano = PELDANOS.find((p) => restanteMs <= p.dias * DIA_MS);
		if (!peldano) continue;

		const gane = await marcarAvisoEnviado(db, {
			licenseId: license.license_id,
			kind: peldano.kind,
			expiresAtMs,
			nowMs: ahoraMs,
		});
		if (!gane) {
			resumen.yaAvisadas += 1;
			continue;
		}

		const enlace = enlaceDeRenovacion(env, license);
		if (!enlace) {
			await olvidarAvisoEnviado(db, { licenseId: license.license_id, kind: peldano.kind, expiresAtMs });
			resumen.fallidos += 1;
			continue;
		}

		const enviado = await sendLicenseExpiringEmail(env, {
			to: license.customer_email,
			name: license.customer_name,
			expiresAtMs,
			// Hacia arriba: a quien le quedan 6 días y medio hay que decirle 7, no 6.
			diasRestantes: Math.max(1, Math.ceil(restanteMs / DIA_MS)),
			enlace,
		});

		if (enviado) {
			resumen.enviados += 1;
		} else {
			// El correo no salió: se suelta la marca para que el ciclo de mañana lo reintente.
			await olvidarAvisoEnviado(db, { licenseId: license.license_id, kind: peldano.kind, expiresAtMs });
			resumen.fallidos += 1;
		}
	}

	return resumen;
}
