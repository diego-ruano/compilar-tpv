// src/lib/rutas.ts
//
// Lo que TODOS los routers de dominio hacían copiado (ARQ-03).
//
// `parseId` estaba escrito doce veces con el mismo cuerpo, y `apply` diez — las dos únicas
// variantes se diferenciaban en una línea en blanco. No es sólo ruido: cuando `apply` cambió para
// mandar `X-Client-Now` (CFG-04), hubo que acordarse de tocar diez ficheros, y el que se olvidara
// habría dejado un dominio replicando con la hora de Turso sin que nada fallara.

import { bodyLimit } from "hono/body-limit";

import { applyViaHub, HubError, type ApplyCommand } from "./hub";
import { recortar } from "./texto";

/** Lo más largo que manda la app en una búsqueda cabe de sobra en 8 KB. */
const TOPE_DE_UNA_BUSQUEDA = 8 * 1024;

/**
 * AUD-27: declara una LECTURA que va por POST, con el tope de su cuerpo.
 *
 * Cloudflare guarda el método y la URL de cada petición, y el cuerpo no. Así que lo que es de una
 * persona (nombre, teléfono, correo) y lo que alguien escribe en un buscador no viaja en la query:
 * la lectura pasa a `post` y lo lleva en el cuerpo. Se declara **delante de `tenantAuth`**, que lee
 * el cuerpo entero para comprobar la firma:
 *
 *     xRoutes.use("/ruta", lecturaPorPost());
 *     xRoutes.use("*", tenantAuth);
 *     xRoutes.post("/ruta", cuerpo(schema), …)   // sólo `tenantQuery`: ni `apply` ni veto de rol
 *
 * Sigue siendo una lectura: no pasa por el `TenantHub`, no pide `X-Idempotency-Key` y `tenantQuery`
 * le fija la hora con `X-Client-Now` como a un GET. Esa primera línea es la que la distingue de
 * una escritura: la leen `test/sinDatosPersonalesEnLaQuery.node.test.ts` (toda ruta que no sea un GET y
 * sólo consulte tiene que llevarla) y `scripts/check-contract-coverage.mjs` (sus consultas cuentan
 * como lecturas con segunda implementación en la Main).
 *
 * `maxBytes` es lo más grande que puede pedir la app por esa ruta. Sin decirlo, lo de una búsqueda.
 */
export function lecturaPorPost(maxBytes: number = TOPE_DE_UNA_BUSQUEDA) {
	return bodyLimit({
		maxSize: maxBytes,
		onError: (c) => c.json({ ok: false, error: "payload_too_large" }, 413),
	});
}

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
