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
import { registrarSinLaCentral } from "../../server/central/sinLaCentral";
import { descifrar } from "../../server/crypto";
import {
	getLicenseById,
	guardarClaveRecifrada,
	licenciasDeStripeSinCorreoDeClaves,
	licenciasSinCorreoDeClaves,
	markKeyEmailSent,
	type LicenseRow,
} from "../../server/licenseStore";
import { sendLicenseKeyEmail } from "./licenseEmails";

/**
 * Lo que tarda como mucho una entrega viva entre que su cobro entra y apunta que el correo con las
 * claves ha salido: el cobro (con su repetición), el correo y las marcas, que son segundos. Un cobro
 * más reciente sin el correo apuntado puede ser el de una entrega que lo está mandando ahora mismo.
 */
export const CORREO_DE_CLAVES_MAX_MS = 5 * 60_000;

/** CLAVES-SIN-CORREO · Cuántos correos de claves reenvía como mucho el cron en un día. */
export const REENVIOS_DE_CLAVES_AL_DIA = 25;

/** La operación del cron, en Sentry y en el evento de la central que no atiende. */
const OPERACION_DEL_CRON = "cron.correo_de_claves";

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
	if (!lic.license_key_enc) throw new Error(`La licencia ${lic.license_id} no tiene su clave guardada.`);
	const { texto: key, recifrado } = await descifrar(env, lic.license_key_enc);
	if (recifrado) await guardarClaveRecifrada(db, lic.license_id, lic.license_key_enc, recifrado);

	const emailSent = await sendLicenseKeyEmail(env, {
		to: lic.customer_email,
		name: lic.customer_name,
		key,
		termMonths: lic.term_months,
	});
	if (emailSent) await markKeyEmailSent(db, lic.license_id);
	return { key, emailSent };
}

/** El aviso de Sentry de unas licencias cuyo correo de claves no se ha podido reenviar. */
function avisarDeQueNoHanSalido(licencias: string[]): void {
	capturarError(
		new Error(
			`Correo de claves sin entregar, y su reenvío no ha salido: si el cliente no lo tiene, ` +
				`pnpm license:resend -- --id <licencia> (licencias ${licencias.join(", ")})`,
		),
		"stripe.correo_de_claves",
	);
}

/**
 * CLAVES-SIN-CORREO · La entrega del webhook que encuentra la sesión `sessionId` ya cumplida reenvía
 * el correo de las licencias que no lo tienen apuntado y se cobraron hace más de
 * `CORREO_DE_CLAVES_MAX_MS`. No puede hacer fallar la entrega: si la central no contesta a la lectura,
 * no hace nada (ya lo hará el cron); si un reenvío no sale, lo avisa en Sentry.
 */
export async function reenviarSiFaltaElCorreoDeClaves(env: Env, db: Sql, sessionId: string): Promise<void> {
	let sinCorreo: string[];
	try {
		sinCorreo = await licenciasSinCorreoDeClaves(db, sessionId, Date.now() - CORREO_DE_CLAVES_MAX_MS);
	} catch {
		return;
	}

	const noHanSalido: string[] = [];
	for (const id of sinCorreo) {
		try {
			const lic = await getLicenseById(db, id);
			if (lic && !(await reenviarCorreoDeClave(env, db, lic)).emailSent) noHanSalido.push(id);
		} catch {
			noHanSalido.push(id);
		}
	}
	if (noHanSalido.length > 0) avisarDeQueNoHanSalido(noHanSalido);
}

export type ResumenDeReenvios = { revisadas: number; reenviados: number; fallidos: number };

/**
 * CLAVES-SIN-CORREO · El ciclo del cron diario: reenvía el correo de claves de las compras de Stripe
 * cobradas antes de `ahoraMs - CORREO_DE_CLAVES_MAX_MS` que no lo tienen apuntado, como mucho `tope`,
 * las más recientes primero. Las que no caben salen al día siguiente.
 *
 * Cada licencia va por su cuenta, como en los avisos de caducidad (`avisosDeCaducidad.ts`): si la
 * central falla con una, cuenta como fallida (su evento en Axiom, y Sentry sólo si no es carga ni un
 * fallo pasajero), y con la central saturada el ciclo se corta. Las que no han salido van juntas en un
 * aviso de Sentry. Si la central no contesta a la lectura del principio, lanza: lo recoge el cron.
 */
export async function reenviarClavesSinCorreo(
	env: Env,
	db: Sql,
	ahoraMs = Date.now(),
	enSegundoPlano: (promesa: Promise<unknown>) => void = (promesa) => void promesa,
	tope = REENVIOS_DE_CLAVES_AL_DIA,
): Promise<ResumenDeReenvios> {
	const pendientes = await licenciasDeStripeSinCorreoDeClaves(db, ahoraMs - CORREO_DE_CLAVES_MAX_MS, tope);
	const resumen: ResumenDeReenvios = { revisadas: pendientes.length, reenviados: 0, fallidos: 0 };
	const noHanSalido: string[] = [];

	for (const [i, lic] of pendientes.entries()) {
		try {
			const { emailSent } = await reenviarCorreoDeClave(env, db, lic);
			if (emailSent) {
				resumen.reenviados += 1;
			} else {
				resumen.fallidos += 1;
				noHanSalido.push(lic.license_id);
			}
		} catch (err) {
			const sinLaCentral = registrarSinLaCentral(err, {
				env,
				enSegundoPlano,
				operacion: OPERACION_DEL_CRON,
				metodo: "cron",
				ruta: OPERACION_DEL_CRON,
			});
			if (!sinLaCentral) capturarError(err, OPERACION_DEL_CRON);
			resumen.fallidos += 1;
			noHanSalido.push(lic.license_id);
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
