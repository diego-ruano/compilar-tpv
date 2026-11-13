// src/middleware/tenant.ts
//
// Middleware de autenticación de tenant para los endpoints de negocio (Handy).
//
// Verifica el JWT HS256 + el "device proof" ed25519 (mismas comprobaciones que el
// resto del worker) y deja en el contexto de Hono el tenant/dispositivo, para que
// los handlers solo tengan que pedir el cliente Turso (lecturas) o aplicar comandos
// vía el DO (escrituras).

import type { MiddlewareHandler } from "hono";

import type { Env } from "../env";
import { getDb } from "../server/db";
import { normalizarRol, SQL_DEVICE_ACTIVO } from "../lib/deviceAuth";
import { verifyJwt, verifyDeviceProofOrThrow } from "../server/middleware/auth";
import { reportarRechazoDeDispositivo } from "../observability/axiom";
import { scrub } from "../observability/scrub";
import { acotar, MAX_FILTRADO } from "../observability/tope";

/**
 * Mantiene viva una entrega de observabilidad más allá de la respuesta.
 *
 * El `try` es por los tests y por cualquier contexto sin `executionCtx`: ahí `c.executionCtx`
 * lanza. Perder un aviso nunca puede tumbar una petición.
 */
function retenerEnvio(c: { executionCtx: Pick<ExecutionContext, "waitUntil"> }, p: Promise<unknown>): void {
	try {
		c.executionCtx.waitUntil(p);
	} catch {
		void p;
	}
}
import { forbidden, unauthorized } from "../server/utils/response";
import { wireToCode } from "../lib/errorCodes";
import { vetoDeLicencia } from "../lib/licenciaEnUso";
import { hubLocal } from "../lib/hubLocal";

/** AUD-32: lo que se guarda de la ruta de una petición rechazada, en bytes de UTF-8 y ya filtrada. */
const MAX_RUTA_EN_TELEMETRIA = { bytes: 256, filtrado: MAX_FILTRADO };

export type TenantVars = {
	tenantId: string;
	deviceId: string;
	token: string;
	/** Hash de la clave de licencia (claim del JWT). Identifica la fila de `licenses`. */
	licHash: string;
	/**
	 * Rol del dispositivo según su fila de la base central (`tpv` | `handy`, normalizado). Lo lee
	 * `tenantAuth` con la clave pública, en la misma consulta. Nunca sale del token ni de una cabecera.
	 */
	rol: string;
	/** La ruta es una lectura que va por POST: la marca su declaración (`lecturaPorPost`, `lib/rutas.ts`). */
	lecturaPorPost?: true;
};

/**
 * Rol del dispositivo según la BD central (`tpv` | `handy`). El JWT no lo lleva: la cabecera
 * `x-role` es del cliente y no puede otorgar privilegios, así que la única fuente es la fila.
 */
export async function rolDelDispositivo(
	env: Env,
	tenantId: string,
	deviceId: string,
): Promise<string> {
	const r = await getDb(env).execute({
		sql: `SELECT role FROM devices WHERE tenant_id=? AND device_id=? AND ${SQL_DEVICE_ACTIVO} LIMIT 1;`,
		args: [tenantId, deviceId],
	});
	return normalizarRol((r.rows?.[0] as any)?.role);
}

/**
 * «Esto sólo lo hace la Main»: el middleware que lo hace cumplir.
 *
 * El identificador y el status los pone quien lo usa porque cada familia de rutas ya devolvía el
 * suyo y eso es contrato con los clientes instalados: `cobro_solo_en_main` y `caja_solo_en_main`
 * con 403, `forbidden_not_tpv` y `forbidden_not_main` con 401 en el emparejamiento.
 *
 * Es un MIDDLEWARE y no una comprobación dentro del handler: tiene que decidir ANTES de que se lea
 * y valide el cuerpo, que también es middleware. Lo vigila `test/anularSoloMain.test.ts`.
 *
 * Dentro del TenantHub (`lib/enElHub.ts`) el rol llega con la identidad: lo leyó el Worker de la
 * fila del dispositivo al autenticar (`tenantAuth`), y volver a pedírselo a la base central desde el
 * DO era un viaje más por petición (de 170 a 230 ms en `/v1/sync/changes`). En el Worker se sigue
 * leyendo aquí, de la fila viva y sin caché.
 */
export function soloLaMain(error: string, status: 401 | 403): MiddlewareHandler<any> {
	return async (c, next) => {
		const dentro = hubLocal();
		const rol = dentro
			? dentro.identidad.rol
			: await rolDelDispositivo(c.env, c.get("tenantId"), c.get("deviceId"));
		// El `code` sale del catálogo (ARCH-05) como en `unauthorized`/`forbidden`, pero sin pasar
		// por ellos: sólo hace falta el identificador y el status, no la `Request`.
		if (rol !== "tpv") return c.json({ ok: false, code: wireToCode(error, status), error }, status);
		await next();
	};
}

/**
 * AUD-02 · `soloLaMain` para las rutas de la Main que se ejecutan en el Worker y no en el TenantHub:
 * emparejar una Handy, ver y desvincular dispositivos y recoger las reservas de la web. Además del
 * rol, la licencia, leída **sin** la caché de un minuto de `tenantAuth`.
 *
 * Con esa caché, el equipo al que se le acaba de trasladar o anular la licencia seguía entrando un
 * minuto en un isolate que lo había dado por bueno. En las rutas que corren dentro del TenantHub lo
 * para el propio hub, que sabe quién es la Main (`MotorTenantHub.vetoDeMain`); éstas no pasan por
 * él, así que se pregunta aquí. Son pocas y se usan poco (la pantalla de vincular, el aviso de una
 * reserva), y lo que hacen no se deshace: aprobar una Handy le da credenciales del negocio, y las
 * reservas recogidas dejan de estar para la Main de verdad. El rechazo es el de `tenantAuth`.
 *
 * Un router cuyas rutas de la Main se queden en el Worker usa éste y no `soloLaMain`; lo vigila
 * `test/mainDesplazadaRest.test.ts`.
 */
export function soloLaMainVigente(error: string, status: 401 | 403): MiddlewareHandler<any> {
	const delRol = soloLaMain(error, status);
	return async (c, next) => {
		let esTpv = false;
		const rechazo = await delRol(c, async () => {
			esTpv = true;
		});
		if (!esTpv) return rechazo;
		if (!hubLocal()) {
			const veto = await vetoDeLicencia(c, { sinCache: true });
			if (veto) return forbidden(c.req.raw, veto);
		}
		await next();
	};
}

/**
 * Cobrar es cosa de la Main y solo de la Main.
 *
 * Una Handy no tiene impresora ni cajón, así que cerrar una mesa desde ella dejaría al cliente sin
 * ticket y el dinero sin registrar en el cajón. Es una decisión de producto, y quien la hace
 * cumplir es el servidor: dejarla solo en la interfaz significa que cualquiera con el token de un
 * Handy podría cobrar igualmente.
 */
export const soloLaMainCobra = soloLaMain("cobro_solo_en_main", 403);

/**
 * La caja se MIRA desde una Handy, pero no se toca (CUENTA-06).
 *
 * Ver los ingresos, los gastos y el histórico de arqueos desde la Handy es útil y no rompe nada.
 * Cambiarlos, no: el cajón, el recuento y la impresora están en la Main, y un gasto corregido desde
 * la sala sin ver el dinero es justo lo que hace que un arqueo deje de significar algo.
 *
 * Como con el cobro, quien lo hace cumplir es el servidor. Esconder el botón en la interfaz deja la
 * puerta abierta a cualquiera con el token de un Handy.
 */
export const soloLaMainEscribeCaja = soloLaMain("caja_solo_en_main", 403);

export const tenantAuth: MiddlewareHandler<{
	Bindings: Env;
	Variables: TenantVars;
}> = async (c, next) => {
	// Dentro del TenantHub (`lib/enElHub.ts`) ya está todo comprobado: el Worker lo hizo antes de
	// pasarle la petición, y la identidad llega con el RPC, no con la petición. Volver a comprobarlo
	// aquí sería volver a la base central desde el DO.
	const dentro = hubLocal();
	if (dentro) {
		c.set("tenantId", dentro.identidad.tenantId);
		c.set("deviceId", dentro.identidad.deviceId);
		c.set("token", dentro.identidad.token);
		c.set("licHash", dentro.identidad.licHash);
		c.set("rol", dentro.identidad.rol);
		await next();
		return;
	}

	try {
		const dbCentral = getDb(c.env);
		const { token, claims } = await verifyJwt(c.env, c.req.raw);

		// El cuerpo entra en la firma (FABLE-E). Se leen los BYTES, no el texto: por aquí pasa la
		// subida de imágenes, y un JPEG leído como texto deja de ser el mismo cuerpo (ver
		// `verifyDeviceProofOrThrow`). Hono cachea el `arrayBuffer`, así que el handler puede
		// seguir haciendo `c.req.json()` —o pidiendo el propio buffer— sin quedarse sin body.
		const rawBody = c.req.raw.body
			? new Uint8Array(await c.req.arrayBuffer())
			: new Uint8Array();
		const { rol } = await verifyDeviceProofOrThrow(c.req.raw, dbCentral, claims, token, rawBody);

		c.set("tenantId", claims.tenantId);
		c.set("deviceId", claims.deviceId);
		c.set("token", token);
		c.set("licHash", claims.licHash);
		c.set("rol", rol);
	} catch (e: any) {
		const motivo = String(e?.message || e);

		// Que un dispositivo no pueda autenticarse deja rastro (agregable en Axiom). Sin esto, un
		// TPV rechazado es invisible para nosotros hasta que su dueño llama por teléfono.
		// `waitUntil` y no `void`: al devolver la respuesta, el runtime de Workers CANCELA lo que
		// quede pendiente sin registrar. Con `void`, este aviso se lanzaba y se moría a medio
		// vuelo — sin error y sin log, simplemente no llegaba nunca a Axiom.
		// AUD-32: esto pasa antes de saber quién llama, y la ruta la elige él (hasta 16 KB). Al
		// evento sólo va su principio, 256 bytes, recortado DESPUÉS de filtrarla (`acotar`): un JWT o
		// un correo en la ruta, partidos antes de filtrar, ya no se reconocerían y quedarían a la vista.
		retenerEnvio(c, reportarRechazoDeDispositivo(c.env, {
			motivo,
			ruta: acotar(new URL(c.req.url).pathname, scrub, MAX_RUTA_EN_TELEMETRIA),
			metodo: c.req.method,
		}));

		// Por `unauthorized` y no por `c.json` a pelo: así la respuesta lleva el `code` del
		// catálogo compartido (ARCH-05) además del `error` de siempre. Es lo que permite al
		// cliente ramificar ante un `device_revoked` en vez de reintentar contra una pared.
		return unauthorized(c.req.raw, motivo);
	}

	// REV-12: y la licencia. Iba sólo delante del ticket del WebSocket, así que con una anulada o
	// caducada seguía valiendo el JWT —30 días, y `/v1/license/status` lo renueva cada seis horas—
	// para mandar correo con nuestro dominio, subir a R2, bajarse el volcado de `/v1/sync/bootstrap`
	// y leer todo lo de la Handy. El cliente se bloqueaba solo porque obedece la aserción firmada:
	// lo único que lo impedía era su buena fe. Va aquí y no en cada ruta para que la siguiente que
	// alguien añada quede cubierta sin acordarse de nada.
	const veto = await vetoDeLicencia(c);
	if (veto) return forbidden(c.req.raw, veto);

	await next();
};
