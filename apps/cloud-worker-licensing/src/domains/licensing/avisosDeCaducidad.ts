// src/domains/licensing/avisosDeCaducidad.ts
//
// «Tu licencia caduca pronto, renuévala aquí» (REV-13).
//
// Una licencia que caduca no avisa sola: el cliente se entera el día que el TPV deja de vender, y
// ése es el peor momento posible. Este job es lo único que lo adelanta.
//
// El enlace es **el de compra de siempre** (`CHECKOUT_URL`), no uno especial de renovación: lo que
// convierte esa compra en tiempo añadido es activar la clave en un equipo que ya tiene licencia
// (REV-13, `licensing.routes.ts`). Así no hay forma de equivocarse comprando por el sitio que no
// es, que era la trampa de la primera versión de esto.
//
// Reglas:
//   · **Sin `CHECKOUT_URL` no se manda nada.** Un aviso que no lleva a ninguna parte no es un
//     aviso: deja al cliente sabiendo que tiene un problema y sin qué hacer con él.
//   · **Un aviso por licencia y por ciclo**, el más urgente que le toque. Con dos peldaños
//     independientes, una licencia que entra al catálogo con 5 días por delante recibiría los dos
//     correos el mismo día.
//   · **Se marca ANTES de enviar y sólo se envía si se ganó la marca.** Dos ejecuciones cruzadas no
//     mandan dos correos. Si el envío falla se suelta la marca, para que el ciclo siguiente lo
//     reintente: un aviso que no ha salido no puede quedar contado como enviado.
//   · **La marca es «enviando» hasta que el aviso sale** (AVISO-CADUCIDAD). Si se queda puesta sin
//     constar enviada (la central falló al soltarla, o entró y su respuesta no volvió), pasado
//     `MARCA_ENVIANDO_MS` la retoma otro ciclo. Si el aviso sale y la central no llega a apuntarlo,
//     también: mejor dos avisos que ninguno.
//   · **Cada licencia va por su cuenta.** Si la central falla con una, al poner o al soltar su
//     marca, esa cuenta como fallida y el ciclo sigue con las demás. Si es que no ha podido atender,
//     queda como en el resto del Worker (`registrarSinLaCentral`): su evento en Axiom, y Sentry sólo si
//     no es carga ni un fallo pasajero. Cualquier otro fallo va a Sentry.
//   · **Con la central saturada, el ciclo se corta**: las que faltan cuentan como fallidas, sin más
//     viajes a una central que no atiende. Mañana se avisa de ellas, como de cualquier otra fallida.

import type { Env } from "../../env";
import { capturarError } from "../../observability/errors";
import { registrarSinLaCentral } from "../../server/central/sinLaCentral";
import type { Sql } from "../../lib/sql";
import {
	confirmarAvisoEnviado,
	licenciasPorCaducar,
	marcarAvisoEnviando,
	olvidarAvisoEnviando,
	type LicenseRow,
} from "../../server/licenseStore";
import { sendLicenseExpiringEmail } from "./licenseEmails";

const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * AVISO-CADUCIDAD · Cuánto es de un ciclo la marca «enviando» que ha puesto: lo bastante para que
 * termine de mandar el correo, y mucho menos que un día, para que el ciclo del día siguiente retome
 * la que se ha quedado puesta sin que conste enviada.
 */
export const MARCA_ENVIANDO_MS = 60 * 60 * 1000;

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
 * El enlace de compra que va en el aviso.
 *
 * Es el de siempre: no hay enlace «de renovación». Lo único que se le añade es el correo, que es
 * comodidad para quien lo abre — y de paso ayuda a que Stripe reutilice el cliente que ya existe,
 * que deja el historial de compras junto en vez de repartido.
 */
export function enlaceDeCompra(env: Env, license: LicenseRow): string | null {
	const base = String(env.CHECKOUT_URL || "").trim();
	if (!base) return null;

	try {
		const url = new URL(base);
		const correo = String(license.customer_email || "").trim();
		if (correo) url.searchParams.set("prefilled_email", correo);
		return url.toString();
	} catch {
		capturarError(new Error("CHECKOUT_URL no es una URL válida"), "license_expiry.checkout_url");
		console.error("[avisos] CHECKOUT_URL no es una URL válida:", base);
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

/** El peldaño que le toca a una licencia que caduca dentro de `restanteMs`, el más urgente; ninguno si no está en la escalera. */
const peldanoDe = (restanteMs: number) => PELDANOS.find((p) => restanteMs <= p.dias * DIA_MS);

/** La operación del cron, en Sentry y en el evento de la central que no atiende. */
const OPERACION = "cron.license_expiry";

/**
 * Un ciclo completo. Lo llama el `scheduled` del worker una vez al día; es idempotente, así que
 * adelantarlo o repetirlo no manda nada de más.
 *
 * La base llega de fuera, como en `cumplir`: así el ciclo se prueba entero contra una base central
 * de pruebas, con el esquema de verdad. `enSegundoPlano` mantiene viva la entrega a Axiom del evento
 * de la central que no atiende: el `waitUntil` del cron.
 */
export async function avisarDeCaducidades(
	env: Env,
	db: Sql,
	ahoraMs = Date.now(),
	enSegundoPlano: (promesa: Promise<unknown>) => void = (promesa) => void promesa,
): Promise<ResumenDeAvisos> {
	const resumen: ResumenDeAvisos = {
		revisadas: 0,
		enviados: 0,
		yaAvisadas: 0,
		fallidos: 0,
		sinEnlace: !String(env.CHECKOUT_URL || "").trim(),
	};

	if (resumen.sinEnlace) {
		capturarError(new Error("Falta CHECKOUT_URL"), "license_expiry.checkout_url");
		console.error("[avisos] falta CHECKOUT_URL: no se avisa de ninguna caducidad");
		return resumen;
	}

	const candidatas = await licenciasPorCaducar(db, ahoraMs, ahoraMs + DIAS_MAX * DIA_MS);
	resumen.revisadas = candidatas.length;

	for (const [i, license] of candidatas.entries()) {
		const expiresAtMs = Number(license.expires_at_ms);
		const restanteMs = expiresAtMs - ahoraMs;
		const peldano = peldanoDe(restanteMs);
		if (!peldano) continue;

		// Cada licencia, por su cuenta (E7a-7): lo que falle con una (la central, al poner, al soltar o
		// al confirmar su marca) cuenta como fallida y no corta a las demás, salvo la central saturada.
		// AVISO-CADUCIDAD: una marca que se queda «enviando» (no se soltó, o entró sin respuesta) la
		// retoma el ciclo de otro día, pasado `MARCA_ENVIANDO_MS`.
		const marca = { licenseId: license.license_id, kind: peldano.kind, expiresAtMs, nowMs: ahoraMs };
		let salio = false;
		try {
			const gane = await marcarAvisoEnviando(db, { ...marca, hastaMs: ahoraMs + MARCA_ENVIANDO_MS });
			if (!gane) {
				resumen.yaAvisadas += 1;
				continue;
			}

			const enlace = enlaceDeCompra(env, license);
			if (!enlace) {
				await olvidarAvisoEnviando(db, marca);
				resumen.fallidos += 1;
				continue;
			}

			salio = await sendLicenseExpiringEmail(env, {
				to: license.customer_email,
				name: license.customer_name,
				expiresAtMs,
				// Hacia arriba: a quien le quedan 6 días y medio hay que decirle 7, no 6.
				diasRestantes: Math.max(1, Math.ceil(restanteMs / DIA_MS)),
				enlace,
			});

			if (salio) {
				// Ha salido, aunque la central no llegue a apuntarlo: entonces su marca caduca y otro día
				// se repite. Mejor dos avisos que ninguno.
				resumen.enviados += 1;
				await confirmarAvisoEnviado(db, marca);
			} else {
				// El correo no salió: se suelta la marca para que el ciclo de mañana lo reintente.
				await olvidarAvisoEnviando(db, marca);
				resumen.fallidos += 1;
			}
		} catch (err) {
			const sinLaCentral = registrarSinLaCentral(err, {
				env,
				enSegundoPlano,
				operacion: OPERACION,
				metodo: "cron",
				ruta: OPERACION,
			});
			if (!sinLaCentral) {
				capturarError(err, OPERACION);
				console.error(`[avisos] la licencia ${license.license_id} falló:`, (err as any)?.message || err);
			}
			// Un aviso que salió ya está contado entre los enviados.
			if (!salio) resumen.fallidos += 1;
			// Saturada, seguir sería un viaje más por licencia a una central que no atiende (en
			// 8e9eff7c, el primer fallo cortaba el ciclo). Las que faltan, fallidas: mañana se reintentan.
			if (sinLaCentral === "saturada") {
				const faltan = candidatas.slice(i + 1).filter((l) => peldanoDe(Number(l.expires_at_ms) - ahoraMs));
				resumen.fallidos += faltan.length;
				break;
			}
		}
	}

	return resumen;
}
