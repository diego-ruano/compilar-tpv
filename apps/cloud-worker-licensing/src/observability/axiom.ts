// src/observability/axiom.ts
//
// Reenvío de eventos estructurados a Axiom mediante su API de ingesta (fetch directo, sin SDK: más
// robusto en Workers y sin dependencias extra).
//
// El TOKEN de Axiom es PRIVADO y vive SÓLO aquí (variable de entorno del worker): nunca se expone
// en el dispositivo. Los dispositivos mandan sus lotes a `/v1/telemetry` (autenticado) y este
// worker los retransmite. Si `AXIOM_TOKEN` no está configurado, el reenvío es un no-op silencioso.

import type { Env } from "../env";

/**
 * Ingesta `events` (array de objetos JSON) en el `dataset` de Axiom.
 *
 * Devuelve `true` si la entrega quedó garantizada y el llamante puede dar el lote por bueno:
 *   - Axiom respondió 2xx, **o**
 *   - Axiom no está configurado (sin `AXIOM_TOKEN`) o no hay eventos → no hay nada que entregar.
 * Devuelve `false` SÓLO si Axiom está configurado pero la ingesta falló (no-2xx o error de red):
 * en ese caso el endpoint responde 5xx para que el dispositivo conserve el lote y reintente
 * ("no perder ninguno"). Nunca lanza.
 */
export async function ingestToAxiom(
	env: Env,
	dataset: string,
	events: unknown[],
): Promise<boolean> {
	if (!env.AXIOM_TOKEN || events.length === 0) return true;

	const url = `https://api.axiom.co/v1/datasets/${encodeURIComponent(dataset)}/ingest`;
	try {
		const resp = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${env.AXIOM_TOKEN}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(events),
		});
		if (!resp.ok) {
			console.warn(
				`[axiom] ingest ${dataset} respondió ${resp.status}: ${await resp
					.text()
					.catch(() => "")}`,
			);
			return false;
		}
		return true;
	} catch (e) {
		console.warn(`[axiom] ingest ${dataset} falló: ${String(e)}`);
		return false;
	}
}

/**
 * Deja rastro de un rechazo de autenticación de dispositivo (device-proof / JWT).
 *
 * NO va a Sentry a propósito: un 401 suelto es esperable (un token caducado, un reloj desviado) y
 * llenaría el proyecto de errores que no hay que mirar. Lo que sí importa es el AGREGADO: durante
 * dos meses este worker rechazó miles de peticiones de un TPV con `device_pubkey_not_registered` y
 * después con `bad_device_signature`, y no quedó rastro en ningún sitio — se descubrió leyendo la
 * consola de un desarrollador. Con esto se puede montar una alerta del tipo "N rechazos del mismo
 * dispositivo en 5 minutos", que es justo la señal que faltaba.
 *
 * Best-effort y sin `await`: la observabilidad no puede añadir latencia ni fallar la petición.
 */
export function reportarRechazoDeDispositivo(
	env: Env,
	campos: {
		motivo: string;
		ruta: string;
		metodo: string;
		tenant_id?: string;
		device_id?: string;
	},
): void {
	const dataset = env.AXIOM_DATASET_SYNC || env.AXIOM_DATASET;
	if (!env.AXIOM_TOKEN || !dataset) return;

	try {
		void ingestToAxiom(env, dataset, [
			{
				_time: new Date().toISOString(),
				service: "tpv-api",
				event: "device_auth_rechazado",
				...campos,
			},
		]);
	} catch {
		/* nunca afecta a la respuesta */
	}
}
