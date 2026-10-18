// src/observability/axiom.ts
//
// Reenvío de eventos estructurados a Axiom mediante su API de ingesta (fetch directo, sin SDK: más
// robusto en Workers y sin dependencias extra).
//
// El TOKEN de Axiom es PRIVADO y vive SÓLO aquí (variable de entorno del worker): nunca se expone
// en el dispositivo. Los dispositivos mandan sus lotes a `/v1/telemetry` (autenticado) y este
// worker los retransmite. Si `AXIOM_TOKEN` no está configurado, el reenvío es un no-op silencioso.

import type { Env } from "../env";
import { scrub, scrubDeep } from "./scrub";

/*
 * ⚠️ REGLA DE ESTE FICHERO: los reporteros DEVUELVEN la promesa de la entrega, y quien los llama
 * tiene que mantenerla viva.
 *
 * En Cloudflare Workers, cuando el manejador devuelve su `Response` el runtime **cancela el
 * trabajo pendiente** que no esté registrado con `waitUntil()`. Un `void ingestToAxiom(...)` se
 * lanza y se mata a medio vuelo: no hay error, no hay log, simplemente no aparece nada en Axiom.
 * Estuvo así desde que se escribió este fichero — se emitía y no llegaba.
 *
 * Devolver la promesa obliga a decidir en cada sitio, que es lo correcto porque no todos pueden
 * hacer lo mismo:
 *   · ruta o middleware de Hono  → `c.executionCtx.waitUntil(...)`  (sin latencia)
 *   · Durable Object             → `this.state.waitUntil(...)`
 *   · sin contexto de ejecución  → `await` (vale: son caminos de error, no el camino caliente)
 */

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

	// ⚠️ El dominio NO es `api.axiom.co`, y esto costó un rato encontrarlo.
	//
	// `api.axiom.co/v1/datasets/<ds>/ingest` es el endpoint **legacy**, y su documentación dice que
	// «ingiere datos en el edge deployment de US East 1». Nuestra organización vive en EU Central 1,
	// así que por ahí los eventos se iban a otra región: la ingesta no daba error, simplemente no
	// aparecían en el dataset. Cada deployment tiene su dominio propio y hay que usar el suyo.
	//
	// Cuál es el tuyo: Axiom → Settings → General → Edge deployment. Se fija al crear la
	// organización y no se puede cambiar después.
	const dominio = env.AXIOM_DOMAIN || "eu-central-1.aws.edge.axiom.co";
	const url = `https://${dominio}/v1/ingest/${encodeURIComponent(dataset)}`;
	try {
		// OBS-01: cubrir también los errores producidos en el worker/DO. Filtrar una copia
		// evita modificar objetos que todavía utiliza el llamante. Si falla, no se envía.
		const payload = structuredClone(events);
		scrubDeep(payload);
		const resp = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${env.AXIOM_TOKEN}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
		});
		if (!resp.ok) {
			console.warn(
				scrub(`[axiom] ingest ${dataset} respondió ${resp.status}: ${await resp
					.text()
					.catch(() => "")}`),
			);
			return false;
		}
		return true;
	} catch (e) {
		console.warn(scrub(`[axiom] ingest ${dataset} falló: ${String(e)}`));
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
 * Best-effort, pero la promesa que devuelve HAY que mantenerla viva (ver la regla de arriba):
 * sin eso el runtime la cancela al responder y no llega nada.
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
): Promise<unknown> {
	const dataset = env.AXIOM_DATASET_SYNC || env.AXIOM_DATASET;
	if (!env.AXIOM_TOKEN || !dataset) return Promise.resolve();

	try {
		return ingestToAxiom(env, dataset, [
			{
				_time: new Date().toISOString(),
				service: "tpv-api",
				event: "device_auth_rechazado",
				...campos,
			},
		]);
	} catch {
		/* nunca afecta a la respuesta */
		return Promise.resolve();
	}
}

/**
 * SYNC-24: el TPV informa de cómo va su sincronización con la nube.
 *
 * Hermano de `reportarRechazoDeDispositivo` y por el mismo motivo: la señal existía y no quedaba
 * en ningún sitio. Un equipo cuya copia de la nube se ha quedado distinta de su base local no lo
 * puede arreglar quien está delante del TPV, así que decírselo a él sería un aviso que aprende a
 * ignorar; quien tiene que enterarse es quien puede actuar, y sin mirar nada.
 *
 * La alerta que esto habilita: `event == "tenant_salud_sync"` con `descuadres` no vacío, agrupado
 * por `tenant_id`. Un descuadre suelto que desaparece al ciclo siguiente es ruido (la foto de la
 * nube se toma sin transacción); lo que hay que vigilar es el que persiste.
 *
 * Best-effort y sin bloquear la respuesta, como todo lo de aquí — pero con la entrega
 * retenida, o el runtime la cancelaría al responder.
 */
export function reportarSaludDeSync(
	env: Env,
	campos: {
		tenant_id?: string;
		device_id?: string;
		descuadres: { tabla: string; faltan: number; sobran: number; distintas: number }[];
		apartadas: number;
		reparadas: number;
		ventana_omitida: boolean;
		reparacion_apagada: boolean;
	},
): Promise<unknown> {
	const dataset = env.AXIOM_DATASET_SYNC || env.AXIOM_DATASET;
	if (!env.AXIOM_TOKEN || !dataset) return Promise.resolve();

	try {
		return ingestToAxiom(env, dataset, [
				{
					_time: new Date().toISOString(),
					service: "tpv-api",
					event: "tenant_salud_sync",
					// Agregados para poder alertar sin desplegar el detalle.
					tablas_descuadradas: campos.descuadres.length,
					filas_descuadradas: campos.descuadres.reduce(
						(n, d) => n + d.faltan + d.sobran + d.distintas,
						0,
					),
				...campos,
			},
		]);
	} catch {
		/* nunca afecta a la respuesta */
		return Promise.resolve();
	}
}

/** Los eventos de la reserva desde la web (docs/estudios/reservas-web.md §9). */
type EventoReservaWeb = "reserva_web_alta" | "reserva_web_rechazo" | "reserva_web_cancelada";

/**
 * Lo que pasa en las rutas públicas de la reserva web. **Sólo ids y motivos**: ni el correo, ni el
 * nombre, ni el teléfono de quien reserva, que no tienen por qué salir de la agenda.
 *
 * La alerta que habilita: muchos `reserva_web_rechazo` con `tope_reservas_negocio` o
 * `limite_reservas_correo` en un negocio es alguien intentando llenarle las mesas.
 */
export function reportarReservaWeb(
	env: Env,
	campos: { event: EventoReservaWeb; tenant_id: string; motivo?: string; id_reserva?: string },
): Promise<unknown> {
	const dataset = env.AXIOM_DATASET_SYNC || env.AXIOM_DATASET;
	if (!env.AXIOM_TOKEN || !dataset) return Promise.resolve();

	try {
		return ingestToAxiom(env, dataset, [
			{ _time: new Date().toISOString(), service: "tpv-reservas-web", ...campos },
		]);
	} catch {
		/* nunca afecta a la respuesta */
		return Promise.resolve();
	}
}
