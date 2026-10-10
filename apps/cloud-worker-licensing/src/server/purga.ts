// src/server/purga.ts
//
// Recogida de basura de la base central. Lo llama el cron diario (`index.ts::programado`).
//
// Tablas que crecerían sin techo si nadie las borrara, y a las que hace crecer alguien de fuera:
//
//   · `pair_claim_fallos` — una fila por IP que falla un emparejamiento. Sólo se borraba al
//     emparejar BIEN, así que un barrido de códigos dejaba su rastro para siempre. Con IPv6 una
//     sola persona tiene billones de direcciones: cada petición barata dejaba una fila permanente.
//     No era un problema de velocidad (esa tabla se lee siempre por su clave primaria, así que da
//     igual lo grande que sea): era almacenamiento sin límite a partir de una entrada que no
//     controlamos.
//   · `email_sends` — una fila por correo enviado, y el tope de REV-14 sólo mira las últimas 24 h.
//   · `license_otp_eventos` (RI-68) — una fila por código de cambio de equipo enviado o fallado, y
//     sus topes sólo miran las últimas 24 h.
//
// Lo que NO se purga, para que no parezca un olvido: `Ws_Tickets` ya se limpia sola al usarse
// (`ws.routes.ts`), y `email_codes` está acotada por su clave (tenant, dispositivo, propósito),
// así que no crece con los intentos.

import type { Sql } from "./db";
import { capturarError } from "../observability/errors";
import { exec } from "./db";
import { OTP_VENTANA_MS } from "../domains/licensing/licensing.helpers";

/**
 * Cuánto se conserva un rastro de fallos de emparejamiento.
 *
 * Es el mismo `OLVIDO_MS` de `pairing.intentos.ts`, y esa igualdad es lo que hace que este borrado
 * **no pierda información**: pasadas 24 h sin fallar, el contador ya vuelve a empezar de cero, o
 * sea que el código trata esa fila como si no existiera. Borrarla no es una política de retención,
 * es tirar lo que ya no significa nada. Si allí se alarga la ventana, hay que alargarla aquí
 * también, o la cuenta se reiniciaría antes de lo que dice el tramo.
 */
export const RETENCION_FALLOS_MS = 24 * 60 * 60 * 1000;

/**
 * Cuánto se conserva la traza de un correo enviado.
 *
 * Aquí sí es una decisión, porque la fila no es sólo un contador: lleva el destinatario, el
 * proveedor y el error, y es con lo que se atiende un «mi pedido no llegó». El tope diario sólo
 * necesita 24 h, así que todo lo demás existe para que lo mire una persona. Noventa días dan de
 * sobra para eso y quitan de encima a largo plazo el `to_email`, que es un dato personal de un
 * tercero: guardarlo para siempre sin que nada lo lea es un pasivo, no un activo.
 *
 * Si algún día se quieren estadísticas de correo, lo que hay que guardar es el agregado (cuántos
 * por negocio y día), no las direcciones.
 */
export const RETENCION_ENVIOS_MS = 90 * 24 * 60 * 60 * 1000;

export type Purgado = {
	fallosDeEmparejamiento: number;
	trazasDeCorreo: number;
	eventosDeCodigo: number;
};

function borradas(r: any): number {
	return Number(r?.rowsAffected ?? r?.rows_affected ?? 0);
}

/**
 * Borra lo caducado de las dos tablas y devuelve cuánto se llevó de cada una.
 *
 * Cada borrado va en su propio `try`: son tablas sin relación, y que una falle no puede dejar a la
 * otra creciendo. Por lo mismo esto NO propaga: es mantenimiento, y un fallo suyo no puede tumbar
 * al resto del cron (los avisos de caducidad sí le importan a alguien que está esperando).
 */
export async function purgarBaseCentral(db: Sql, ahoraMs: number = Date.now()): Promise<Purgado> {
	const purgado: Purgado = { fallosDeEmparejamiento: 0, trazasDeCorreo: 0, eventosDeCodigo: 0 };

	try {
		const r = await exec(db, `DELETE FROM pair_claim_fallos WHERE ultimo_fallo_ms < ?1;`, [
			ahoraMs - RETENCION_FALLOS_MS,
		]);
		purgado.fallosDeEmparejamiento = borradas(r);
	} catch (e: any) {
		capturarError(e, "purge.pair_claim_failures");
		console.error("[purga] pair_claim_fallos falló:", String(e?.message || e));
	}

	try {
		const r = await exec(db, `DELETE FROM email_sends WHERE sent_at_ms < ?1;`, [
			ahoraMs - RETENCION_ENVIOS_MS,
		]);
		purgado.trazasDeCorreo = borradas(r);
	} catch (e: any) {
		capturarError(e, "purge.email_audit");
		console.error("[purga] email_sends falló:", String(e?.message || e));
	}

	// Igual que `pair_claim_fallos`: la ventana es la de los topes (`OTP_VENTANA_MS`), así que lo que
	// se borra es lo que ya no cuenta para nada.
	try {
		const r = await exec(db, `DELETE FROM license_otp_eventos WHERE at_ms < ?1;`, [
			ahoraMs - OTP_VENTANA_MS,
		]);
		purgado.eventosDeCodigo = borradas(r);
	} catch (e: any) {
		capturarError(e, "purge.license_otp_events");
		console.error("[purga] license_otp_eventos falló:", String(e?.message || e));
	}

	return purgado;
}
