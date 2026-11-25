// src/observability/axiom.ts
//
// Reenvío de eventos estructurados a Axiom mediante su API de ingesta (fetch directo, sin SDK: más
// robusto en Workers y sin dependencias extra).
//
// El TOKEN de Axiom es PRIVADO y vive SÓLO aquí (variable de entorno del worker): nunca se expone
// en el dispositivo. Los dispositivos mandan sus lotes a `/v1/telemetry` (autenticado) y este
// worker los retransmite. Si `AXIOM_TOKEN` no está configurado, el reenvío es un no-op silencioso.

import type { Env } from "../env";
import type { CentralNoDisponible, ErrorDeLaCentral } from "../server/central/cliente";
import { scrub, scrubDeep } from "./scrub";
import { acotar } from "./tope";

/** Lo más que espera una ingesta a Axiom (AUD-46). */
const PLAZO_INGESTA_MS = 15_000;

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
		// AUD-32: cada cadena de la copia se filtra con sus topes (`tope.ts`).
		const payload = structuredClone(events);
		scrubDeep(payload, acotar);
		const resp = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${env.AXIOM_TOKEN}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
			// AUD-46: el TenantHub entrega esto por `waitUntil`, y un DO no hiberna mientras le
			// quede una sin terminar. Vencido, es un fallo de ingesta como cualquier otro.
			signal: AbortSignal.timeout(PLAZO_INGESTA_MS),
		});
		if (!resp.ok) {
			console.warn(
				acotar(`[axiom] ingest ${dataset} respondió ${resp.status}: ${await resp
					.text()
					.catch(() => "")}`, scrub),
			);
			return false;
		}
		return true;
	} catch (e) {
		console.warn(acotar(`[axiom] ingest ${dataset} falló: ${String(e)}`, scrub));
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
 * por `tenant_id`. Un descuadre que la pasada repara desaparece al ciclo siguiente; lo que hay que
 * vigilar es el que persiste, y el que sale con `aplazado` (visto y no tocado).
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
		borradas: number;
		aplazado: boolean;
		filas_examinadas: number;
		tablas_sin_comparar: string[];
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

/**
 * El objeto de un negocio no ha podido atender una petición (`lib/enElHub.ts`): saturado, con un
 * fallo pasajero de la plataforma, u otra cosa. Uno suelto es normal (cada despliegue reinicia los
 * objetos); lo que hay que mirar es el agregado por `tenant_id`, que es un negocio cuyo objeto no
 * da abasto o no arranca.
 */
export function reportarHubNoDisponible(
	env: Env,
	campos: {
		tenant_id: string;
		motivo: "saturado" | "pasajero" | "otro";
		/** Si era una lectura y ya se había repetido una vez. */
		repetida: boolean;
		metodo: string;
		ruta: string;
		error: string;
	},
): Promise<unknown> {
	const dataset = env.AXIOM_DATASET_SYNC || env.AXIOM_DATASET;
	if (!env.AXIOM_TOKEN || !dataset) return Promise.resolve();

	try {
		return ingestToAxiom(env, dataset, [
			{ _time: new Date().toISOString(), service: "tpv-api", event: "hub_no_disponible", ...campos },
		]);
	} catch {
		/* nunca afecta a la respuesta */
		return Promise.resolve();
	}
}

/**
 * La base central no ha podido atender una petición (`server/central/sinLaCentral.ts`). `motivo`:
 * saturada, un fallo pasajero de la plataforma, sin contestar a tiempo (`plazo`), o el código con el
 * que el objeto dice que no puede (`central_sin_aprovisionar`, `central_migracion_alterada`…). Es una
 * para todo el servicio: lo que hay que mirar es la racha, sea del negocio que sea. `tenant_id` va
 * cuando la petición es de uno, para poder cruzarlo.
 */
export function reportarCentralNoDisponible(
	env: Env,
	campos: {
		motivo: CentralNoDisponible["motivo"] | ErrorDeLaCentral["code"];
		metodo: string;
		ruta: string;
		error: string;
		tenant_id?: string;
	},
): Promise<unknown> {
	const dataset = env.AXIOM_DATASET_SYNC || env.AXIOM_DATASET;
	if (!env.AXIOM_TOKEN || !dataset) return Promise.resolve();

	try {
		return ingestToAxiom(env, dataset, [
			{ _time: new Date().toISOString(), service: "tpv-api", event: "central_no_disponible", ...campos },
		]);
	} catch {
		/* nunca afecta a la respuesta */
		return Promise.resolve();
	}
}

/**
 * Lo que la administración hace con la base central (`domains/admin/central.ts`): copiarla, darle
 * esquema o restaurarla, y devolverla a un instante. No va en `admin_audit`, que es una tabla de la
 * propia central: restaurarla o devolverla a un instante la reescriben. Sin datos personales: la
 * acción, la clave de la copia, las filas, los marcadores y el resultado.
 */
export function reportarAdministracionDeLaCentral(
	env: Env,
	campos: {
		accion: "copiar" | "aprovisionar" | "restaurar" | "volver";
		/**
		 * `ok`, o el código con el que no se ha hecho. Al volver, antes de reiniciar, `preparada`: si la
		 * llamada no termina, es lo que queda de con qué se deshace.
		 */
		resultado: string;
		clave?: string;
		filas?: number;
		tablas?: number;
		/** Al volver: el instante (ISO) o el marcador al que se vuelve, y con qué se deshace. */
		destino?: string;
		deshacer?: string;
		copiaDeAntes?: string;
		/** Por qué no se ha hecho, si lo dice el objeto. */
		detalle?: string;
	},
): Promise<unknown> {
	const dataset = env.AXIOM_DATASET_SYNC || env.AXIOM_DATASET;
	if (!env.AXIOM_TOKEN || !dataset) return Promise.resolve();

	try {
		return ingestToAxiom(env, dataset, [
			{ _time: new Date().toISOString(), service: "tpv-api", event: "central_administrada", ...campos },
		]);
	} catch {
		/* nunca afecta a la respuesta */
		return Promise.resolve();
	}
}

/** Los eventos de la reserva desde la web (docs/estudios/reservas-web.md §9). */
type EventoReservaWeb =
	| "reserva_web_alta"
	// El widget repite un alta que ya había dado reserva: se contesta la misma.
	| "reserva_web_alta_repetida"
	| "reserva_web_rechazo"
	| "reserva_web_cancelada"
	// La entrega a la Main, desde la agenda.
	| "reserva_web_entregada"
	| "reserva_web_vista"
	| "reserva_web_reofrecida"
	| "reserva_web_fallida"
	| "reserva_web_atascada";

/**
 * Lo que pasa en las rutas públicas de la reserva web. **Sólo ids y motivos**: ni el correo, ni el
 * nombre, ni el teléfono de quien reserva, que no tienen por qué salir de la agenda.
 *
 * Las alertas que habilita: muchos `reserva_web_rechazo` con `tope_reservas_negocio`,
 * `tope_reservas_conexion` o `limite_reservas_correo` en un negocio es alguien intentando llenarle
 * las mesas; un
 * `reserva_web_atascada` es una Main que lleva días sin recoger, y un `reserva_web_fallida`, una
 * reserva confirmada que el restaurante no tiene.
 */
export function reportarReservaWeb(
	env: Env,
	campos: { event: EventoReservaWeb; tenant_id: string; motivo?: string; id_reserva?: string; cuantas?: number },
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
