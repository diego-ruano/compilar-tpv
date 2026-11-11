// src/lib/rutas.ts
//
// Lo que TODOS los routers de dominio hacían copiado (ARQ-03).
//
// `parseId` estaba escrito doce veces con el mismo cuerpo, y `apply` diez — las dos únicas
// variantes se diferenciaban en una línea en blanco. No es sólo ruido: cuando `apply` cambió para
// mandar `X-Client-Now` (CFG-04), hubo que acordarse de tocar diez ficheros, y el que se olvidara
// habría dejado un dominio replicando con la hora de la base sin que nada fallara.

import { applyViaHub, HubError, type ApplyCommand } from "./hub";
import { recortar } from "./texto";

/**
 * Un identificador que viene en la ruta: `null` si no hay nada que mirar. Se recorta igual que el
 * que llega en un cuerpo (VALID-01): si no, un id dado de alta con U+FEFF delante se buscaba sin él.
 */
export function parseId(raw: string | undefined): string | null {
	const t = recortar(raw ?? "");
	return t.length ? t : null;
}

/**
 * Aplica un comando de escritura por el Durable Object del negocio.
 *
 * La `X-Idempotency-Key` es obligatoria y la pone el cliente: es lo que hace que un reintento
 * —una Handy que pierde la respuesta y repite— no cobre dos veces. Sin ella no se aplica nada.
 */
export async function apply(
	c: any,
	built: { commandName: string; command: ApplyCommand; cloudPayload: any },
): Promise<any> {
	const opId = recortar(c.req.header("X-Idempotency-Key") || "");
	if (!opId) throw new HubError("missing_op_id", 400);

	return applyViaHub(c.env, {
		tenantId: c.get("tenantId"),
		deviceId: c.get("deviceId"),
		// CFG-04: la hora la pone quien escribe, no la base que aplica.
		clientNow: c.req.header("X-Client-Now") || undefined,
		opId,
		commandName: built.commandName,
		command: built.command,
		cloudPayload: built.cloudPayload,
	});
}
