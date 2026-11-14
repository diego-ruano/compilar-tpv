// src/lib/rutas.ts
//
// Lo que TODOS los routers de dominio hacían copiado (ARQ-03).
//
// `parseId` estaba escrito doce veces con el mismo cuerpo, y `apply` diez — las dos únicas
// variantes se diferenciaban en una línea en blanco. No es sólo ruido: cuando `apply` cambió para
// mandar `X-Client-Now` (CFG-04), hubo que acordarse de tocar diez ficheros, y el que se olvidara
// habría dejado un dominio replicando con la hora de la base sin que nada fallara.

import type { MiddlewareHandler } from "hono";
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
 *     xRoutes.use("*", tenantAuth, alHub);
 *     xRoutes.post("/ruta", cuerpo(schema), …)   // sólo `tenantQuery`: ni `apply` ni veto de rol
 *
 * Sigue siendo una lectura: no pasa por el motor de escrituras del `TenantHub` (ni se aplica ni se
 * replica nada), no pide `X-Idempotency-Key` y `tenantQuery` le fija la hora con `X-Client-Now`
 * como a un GET. Como toda ruta de negocio, se ejecuta dentro del `TenantHub` (`lib/enElHub.ts`): el
 * tope se comprueba en el Worker, antes de autenticar, y un cuerpo que pasa de él no llega al DO. Esa primera línea es la que la distingue de
 * una escritura: la leen `test/sinDatosPersonalesEnLaQuery.node.test.ts` (toda ruta que no sea un GET y
 * sólo consulte tiene que llevarla) y `scripts/check-contract-coverage.mjs` (sus consultas cuentan
 * como lecturas con segunda implementación en la Main).
 *
 * `maxBytes` es lo más grande que puede pedir la app por esa ruta. Sin decirlo, lo de una búsqueda.
 */
export function lecturaPorPost(maxBytes: number = TOPE_DE_UNA_BUSQUEDA): MiddlewareHandler {
	const tope = bodyLimit({
		maxSize: maxBytes,
		onError: (c) => c.json({ ok: false, error: "payload_too_large" }, 413),
	});
	return (c, next) => {
		// Para `alHub`: una lectura se puede repetir si el objeto del negocio falla de forma pasajera.
		c.set("lecturaPorPost", true);
		return tope(c, next);
	};
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
 * AUD-32: la forma de una `X-Idempotency-Key`: de 16 a 64 letras, cifras, guiones o guiones bajos.
 * La Handy manda un UUIDv7 (`CloudClient` de `tpv-infra-http`). La clave es el `Op_Id` de la
 * operación: se guarda en la base del negocio, viaja a la Main y sale en los eventos de `tpv-sync`,
 * y una cabecera puede ocupar 128 KB. La misma forma que la clave del widget de reservas
 * (`CLAVE_DE_INTENTO`, `publico.routes.ts`).
 */
const CLAVE_DE_IDEMPOTENCIA = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * Aplica un comando de escritura por el Durable Object del negocio.
 *
 * La `X-Idempotency-Key` es obligatoria y la pone el cliente: es lo que hace que un reintento
 * —una Handy que pierde la respuesta y repite— no cobre dos veces. Sin ella, o con una que no
 * tiene su forma, no se aplica nada ni se llama al Durable Object.
 */
export async function apply(
	c: any,
	built: { commandName: string; command: ApplyCommand; cloudPayload: any },
): Promise<any> {
	const opId = recortar(c.req.header("X-Idempotency-Key") || "");
	if (!opId) throw new HubError("missing_op_id", 400);
	if (!CLAVE_DE_IDEMPOTENCIA.test(opId)) throw new HubError("invalid_op_id", 400);

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

/**
 * ¿Hizo la escritura lo que se pedía? Para una ruta que mira el recuento que devuelve `apply` (el de un
 * `tenantDb.exec`, o el `saveAs` de un paso de una transacción). Con un número, el recuento: 0 es que no
 * tocó nada. `null` es que no se sabe cuántas filas tocó, y se mira el estado (`quedoComoSePidio`, que
 * sólo se llama en ese caso): un reintento con la misma `X-Idempotency-Key` devuelve el `Result_Json`
 * guardado, que sólo lleva el recuento si se llegó a refinar después de aplicarla (SYNC-10, que es
 * best-effort); y el lote se confirma también cuando la escritura condicional no toca ninguna fila, así
 * que `null` puede ser «hecho» o «no se pudo». Es lo que hace ya borrar un ticket (AUD-14); salió en
 * AUD-26.
 *
 * Si lo que decide es una condición previa (que exista lo que se edita, que no esté en uso lo que se
 * quita), mejor una guarda en el comando (SYNC-30): decide dentro del lote, el reintento de lo que
 * entró contesta lo guardado y la ruta no mira el resultado. Así van editar una ficha, editar una
 * asignación de un tramo y quitar un producto (SYNC-35).
 */
export async function decidirPorEstado(
	resultado: unknown,
	quedoComoSePidio: () => Promise<boolean>,
): Promise<boolean> {
	if (typeof resultado === "number") return resultado > 0;
	return quedoComoSePidio();
}
