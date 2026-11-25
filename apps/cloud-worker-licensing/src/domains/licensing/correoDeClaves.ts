// src/domains/licensing/correoDeClaves.ts
//
// El correo con la clave de una licencia, reenviado: el de `pnpm license:resend` (la ruta de
// administración), y CLAVES-SIN-CORREO (G7), el que sale solo cuando el de una compra no consta como
// entregado (`key_email_sent_at_ms` a NULL).
//
// El correo de una compra sale después de su cobro, y sólo de la entrega del webhook que lo emitió
// (`stripe.routes.ts::cumplir`). Si esa entrega se corta entre el cobro y el correo o su marca, nadie
// más lo manda: la entrega siguiente encuentra la sesión cumplida, y las claves de otra entrega no las
// tiene en claro. Así que se reenvía: lo hace esa entrega siguiente, si el cobro tiene más de
// `CORREO_DE_CLAVES_MAX_MS`, y el cron diario, con cualquier compra de Stripe en ese caso. Lo peor es
// que lleguen dos correos (dos entregas a la vez, o una que mandó el correo y no llegó a apuntarlo);
// mejor eso que un comprador sin sus claves. Sentry, sólo si el reenvío no sale.
//
// Sólo las de Stripe: una licencia manual se emite sin `--send-key` a propósito (se la da el
// administrador), y la suya no consta nunca. Y sólo las que siguen sin estrenar: una activada, canjeada
// o anulada ya no necesita su clave.

import type { Env } from "../../env";
import type { Sql } from "../../lib/sql";
import { capturarError } from "../../observability/errors";
import { registrarSinLaCentral, type DondeSinLaCentral } from "../../server/central/sinLaCentral";
import { descifrar } from "../../server/crypto";
import {
	guardarClaveRecifrada,
	licenciasDeStripeSinCorreoDeClaves,
	licenciasSinCorreoDeClaves,
	markKeyEmailSent,
	type LicenseRow,
} from "../../server/licenseStore";
import { sendLicenseKeyEmail, sendLicenseKeysEmail } from "./licenseEmails";

/**
 * Lo que tarda como mucho una entrega viva entre que su cobro entra y apunta que el correo con las
 * claves ha salido: el cobro (con su repetición), el correo y las marcas, que son segundos. Un cobro
 * más reciente sin el correo apuntado puede ser el de una entrega que lo está mandando ahora mismo.
 */
export const CORREO_DE_CLAVES_MAX_MS = 5 * 60_000;

/** CLAVES-SIN-CORREO · Cuántos correos de claves reenvía como mucho el cron en un día. */
const REENVIOS_DE_CLAVES_AL_DIA = 25;

/** La operación del cron, en Sentry y en el evento de la central que no atiende. */
const OPERACION_DEL_CRON = "cron.correo_de_claves";

/** La de la entrega del webhook. */
const OPERACION_DEL_WEBHOOK = "stripe.correo_de_claves";

/**
 * Reenvía al correo de la compra el correo con la clave de `lic`, y lo apunta si sale. Devuelve la
 * clave en claro (la ruta de administración la enseña) y si el correo ha salido. Si estaba cifrada
 * con la clave anterior de `LICENSE_STORE_KEY`, la guarda ya con la actual (RI-73). Lanza si la
 * licencia no tiene su clave guardada o no se deja descifrar.
 */
export async function reenviarCorreoDeClave(
	env: Env,
	db: Sql,
	lic: LicenseRow,
): Promise<{ key: string; emailSent: boolean }> {
	const r = await mandarCorreoDeClave(env, db, lic);
	if (r.emailSent) await markKeyEmailSent(db, [lic.license_id]);
	return r;
}

/** El correo con la clave de `lic`, sin apuntarlo. */
async function mandarCorreoDeClave(env: Env, db: Sql, lic: LicenseRow): Promise<{ key: string; emailSent: boolean }> {
	const key = await claveEnClaro(env, db, lic);
	const emailSent = await sendLicenseKeyEmail(env, {
		to: lic.customer_email,
		name: lic.customer_name,
		key,
		termMonths: lic.term_months,
	});
	return { key, emailSent };
}

/**
 * La clave de `lic` en claro. Si estaba cifrada con la clave anterior de `LICENSE_STORE_KEY`, la
 * guarda ya con la actual (RI-73). Lanza si no la tiene guardada o no se deja descifrar.
 */
async function claveEnClaro(env: Env, db: Sql, lic: LicenseRow): Promise<string> {
	if (!lic.license_key_enc) throw new Error(`La licencia ${lic.license_id} no tiene su clave guardada.`);
	const { texto, recifrado } = await descifrar(env, lic.license_key_enc);
	if (recifrado) await guardarClaveRecifrada(db, lic.license_id, lic.license_key_enc, recifrado);
	return texto;
}

/** El aviso de Sentry de unas licencias cuyo correo de claves no se ha podido reenviar. */
function avisarDeQueNoHanSalido(licencias: string[]): void {
	capturarError(
		new Error(
			`Correo de claves sin entregar, y su reenvío no ha salido: si el cliente no lo tiene, ` +
				`pnpm license:resend -- --id <licencia> (licencias ${licencias.join(", ")})`,
		),
		OPERACION_DEL_WEBHOOK,
	);
}

/**
 * El correo de claves de `licencias` ha salido, pero no se ha podido apuntar. No es que no haya
 * salido: el comprador tiene sus claves, y sin la marca el cron lo repetirá (otro correo). Si es la
 * central que no atiende, queda como siempre (su evento en Axiom, y Sentry si no es carga ni un fallo
 * pasajero); si es otra cosa, a Sentry con este texto. Devuelve lo que dice `registrarSinLaCentral`.
 */
function registrarQueNoSeHaApuntado(
	err: unknown,
	licencias: string[],
	donde: DondeSinLaCentral,
): ReturnType<typeof registrarSinLaCentral> {
	const sinLaCentral = registrarSinLaCentral(err, donde);
	if (!sinLaCentral) {
		capturarError(
			new Error(
				`El correo de claves ha salido, pero no se ha podido apuntar: se repetirá (licencias ${licencias.join(", ")})`,
				{ cause: err },
			),
			donde.operacion,
		);
	}
	return sinLaCentral;
}

/**
 * CLAVES-SIN-CORREO · La entrega del webhook que encuentra la sesión `sessionId` ya cumplida reenvía
 * el correo de las licencias que no lo tienen apuntado y se cobraron hace más de
 * `CORREO_DE_CLAVES_MAX_MS`: el de la compra, uno solo con todas las claves que faltan
 * (`sendLicenseKeysEmail`), en tres viajes a la central, sean cuantas sean (hasta
 * `MAX_LICENCIAS_POR_COMPRA`), para no retener la respuesta a Stripe. No puede hacer fallar la
 * entrega: si la central no contesta a la lectura, no hace nada (ya lo hará el cron); si el reenvío no
 * sale, lo avisa en Sentry; si sale y no se llega a apuntar, no es eso (`registrarQueNoSeHaApuntado`).
 */
export async function reenviarSiFaltaElCorreoDeClaves(env: Env, db: Sql, sessionId: string): Promise<void> {
	let sinCorreo: LicenseRow[];
	try {
		sinCorreo = await licenciasSinCorreoDeClaves(db, sessionId, Date.now() - CORREO_DE_CLAVES_MAX_MS);
	} catch {
		return;
	}
	if (sinCorreo.length === 0) return;

	const ids = sinCorreo.map((l) => l.license_id);
	let salio = false;
	try {
		const claves = [];
		for (const lic of sinCorreo) claves.push({ key: await claveEnClaro(env, db, lic), termMonths: lic.term_months });
		const [{ customer_email: to, customer_name: name }] = sinCorreo;
		salio = await sendLicenseKeysEmail(env, { to, name, claves });
	} catch {
		salio = false;
	}
	if (!salio) {
		avisarDeQueNoHanSalido(ids);
		return;
	}

	try {
		await markKeyEmailSent(db, ids);
	} catch (err) {
		// Sin el contexto de la petición, el evento de Axiom se espera aquí: es uno, y la entrega ya ha
		// hecho lo suyo.
		const eventos: Promise<unknown>[] = [];
		registrarQueNoSeHaApuntado(err, ids, {
			env,
			enSegundoPlano: (promesa) => eventos.push(promesa),
			operacion: OPERACION_DEL_WEBHOOK,
			metodo: "POST",
			ruta: "/v1/stripe/webhook",
		});
		await Promise.allSettled(eventos);
	}
}

export type ResumenDeReenvios = {
	revisadas: number;
	/** Los que han salido, apuntados o no. */
	reenviados: number;
	/** Los que han salido y no se han llegado a apuntar: el día siguiente se repiten. */
	sinApuntar: number;
	fallidos: number;
};

/**
 * CLAVES-SIN-CORREO · El ciclo del cron diario: reenvía el correo de claves de las compras de Stripe
 * cobradas antes de `ahoraMs - CORREO_DE_CLAVES_MAX_MS` que no lo tienen apuntado, como mucho `tope`,
 * las más recientes primero. Las que no caben salen al día siguiente.
 *
 * Cada licencia va por su cuenta, como en los avisos de caducidad (`avisosDeCaducidad.ts`): si la
 * central falla con una, cuenta como fallida (su evento en Axiom, y Sentry sólo si no es carga ni un
 * fallo pasajero), y con la central saturada el ciclo se corta. Las que no han salido van juntas en un
 * aviso de Sentry. Si el correo sale y lo que falla es apuntarlo, cuenta como reenviado y sin apuntar,
 * no como fallido. Si la central no contesta a la lectura del principio, lanza: lo recoge el cron.
 */
export async function reenviarClavesSinCorreo(
	env: Env,
	db: Sql,
	ahoraMs = Date.now(),
	enSegundoPlano: (promesa: Promise<unknown>) => void = (promesa) => void promesa,
	tope = REENVIOS_DE_CLAVES_AL_DIA,
): Promise<ResumenDeReenvios> {
	const pendientes = await licenciasDeStripeSinCorreoDeClaves(db, ahoraMs - CORREO_DE_CLAVES_MAX_MS, tope);
	const resumen: ResumenDeReenvios = { revisadas: pendientes.length, reenviados: 0, sinApuntar: 0, fallidos: 0 };
	const noHanSalido: string[] = [];
	const donde: DondeSinLaCentral = {
		env,
		enSegundoPlano,
		operacion: OPERACION_DEL_CRON,
		metodo: "cron",
		ruta: OPERACION_DEL_CRON,
	};

	for (const [i, lic] of pendientes.entries()) {
		let salio = false;
		try {
			salio = (await mandarCorreoDeClave(env, db, lic)).emailSent;
			if (!salio) {
				resumen.fallidos += 1;
				noHanSalido.push(lic.license_id);
				continue;
			}
			await markKeyEmailSent(db, [lic.license_id]);
			resumen.reenviados += 1;
		} catch (err) {
			let sinLaCentral: ReturnType<typeof registrarSinLaCentral>;
			if (salio) {
				resumen.reenviados += 1;
				resumen.sinApuntar += 1;
				sinLaCentral = registrarQueNoSeHaApuntado(err, [lic.license_id], donde);
			} else {
				sinLaCentral = registrarSinLaCentral(err, donde);
				if (!sinLaCentral) capturarError(err, OPERACION_DEL_CRON);
				resumen.fallidos += 1;
				noHanSalido.push(lic.license_id);
			}
			// Saturada, seguir sería un viaje más por licencia a una central que no atiende. Las que
			// faltan, fallidas: mañana se reintentan.
			if (sinLaCentral === "saturada") {
				resumen.fallidos += pendientes.length - i - 1;
				break;
			}
		}
	}

	if (noHanSalido.length > 0) avisarDeQueNoHanSalido(noHanSalido);
	return resumen;
}
