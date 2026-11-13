// src/lib/enElHub.ts
//
// Un solo viaje al TenantHub por petición.
//
// La base de cada negocio vive en el SQLite de su TenantHub. Si la ruta se ejecuta en el Worker, cada
// consulta es un viaje de ida y vuelta hasta el DO (`tenantClient.ts`), y una pantalla como fichar
// hace siete seguidos. El viaje es lo caro, no el SQL: el DO se pide en Europa occidental
// (`lib/objetosDelNegocio.ts`) y puede quedar lejos del Worker que atiende. Por eso las rutas de
// negocio se ejecutan DENTRO del DO: el Worker
// comprueba quién pregunta y le pasa la petición entera al TenantHub del negocio, que ejecuta la
// misma ruta (`app.ts`) con su base en local. Cuesta un viaje, esté donde esté el DO.
//
// Reglas:
//
// - Lo que se decide con la base central y no con la del negocio —el token, la firma del
//   dispositivo, la licencia (`tenantAuth`)— se queda en el Worker y va delante: un dispositivo
//   rechazado no despierta al DO.
// - La identidad viaja como argumento del RPC (`ejecutarRuta`), nunca en una cabecera: las cabeceras
//   las escribe el cliente, y el `/ws` le pasa las suyas al DO.
// - Dentro del DO, `tenantAuth` no vuelve a comprobar nada: se fía de esa identidad, que sólo puede
//   venir del Worker porque un DO no es accesible desde fuera.
// - Qué rutas van dentro lo decide cada router poniendo `alHub` justo detrás de `tenantAuth`. Los
//   demás middlewares del router (vetos de rol, validación del cuerpo) corren ya dentro, una vez.
// - Lo enciende `EJECUTAR_EN_EL_HUB = "1"` (`wrangler.json`). Con otro valor, o sin él, la ruta se
//   ejecuta en el Worker y cada consulta vuelve a ser un viaje: sirve para medir las dos formas con el
//   mismo código, y es lo que ven los tests que montan un router suelto con un entorno de mentira.
// - Si el viaje falla porque el objeto no está para atender (saturado, reiniciándose), eso no es
//   un fallo del programa: sale como un 503 con su nombre, no como un `internal_error`. Ver
//   `sinElObjeto`.

import type { Context, MiddlewareHandler } from "hono";

import type { Env } from "../env";
import type { IdentidadDelWorker } from "../durableObjects/tenantHub.rpc";
import type { TenantVars } from "../middleware/tenant";
import { reportarHubNoDisponible } from "../observability/axiom";
import { capturarError } from "../observability/errors";
import { scrub } from "../observability/scrub";
import { anotarDesgloseDelHub, medirTramo } from "../observability/tiempos";
import { acotar, MAX_FILTRADO } from "../observability/tope";
import { hubDe } from "./hub";
import { hubLocal } from "./hubLocal";

type Ctx = Context<{ Bindings: Env; Variables: TenantVars }>;

/** Cuánto se le dice al cliente que espere antes de repetir, con el objeto saturado. */
const ESPERA_SI_SATURADO_S = 2;

/**
 * Lo que Cloudflare marca en el error de una llamada a un Durable Object
 * (https://developers.cloudflare.com/durable-objects/best-practices/error-handling/):
 *
 * - `overloaded`: el objeto tiene más de lo que puede atender. Repetir en el acto lo empeora.
 * - `retryable`: un fallo pasajero de la plataforma (el objeto se reinicia tras un despliegue, su
 *   almacenamiento no contestó…). Se puede repetir, con un stub nuevo: el anterior puede haber
 *   quedado roto.
 *
 * Lo que una ruta lanza dentro del DO no llega aquí como excepción: lo recoge allí el `onError` de
 * la `app`, que lo manda a Sentry y contesta su 500. Una excepción de `ejecutarRuta` es, por tanto,
 * que el objeto no ha llegado a atender la petición o no ha podido devolver la respuesta.
 */
type FalloDelObjeto = { overloaded?: unknown; retryable?: unknown; message?: unknown };

/**
 * ¿Es una lectura? Un GET, o un POST declarado con `lecturaPorPost()` (`lib/rutas.ts`). Repetirla
 * no cambia nada. Una escritura no se repite aquí: la repite el cliente con su misma
 * `X-Idempotency-Key`, que es lo que sabe si se llegó a aplicar.
 */
function esLectura(c: Ctx): boolean {
	return c.req.method === "GET" || c.req.method === "HEAD" || c.get("lecturaPorPost") === true;
}

/**
 * El objeto del negocio no ha podido atender la petición: un 503 `external`, que el cliente trata
 * como la nube sin disponibilidad y no como un fallo del programa (una escritura la repite con su
 * misma clave). Saturado lleva `Retry-After`. Queda anotado en Axiom (`hub_no_disponible`), y lo
 * que la plataforma no da por pasajero va además a Sentry y al log: ahí puede haber algo que
 * arreglar (una respuesta que no cabe en el RPC, un fallo fuera de la `app`).
 */
function sinElObjeto(c: Ctx, tenantId: string, error: unknown, repetida: boolean): Response {
	const fallo = (error ?? {}) as FalloDelObjeto;
	const saturado = fallo.overloaded === true;
	const pasajero = saturado || fallo.retryable === true;
	if (!pasajero) {
		capturarError(error, "hub.ejecutar_ruta");
		// FABLE-B: la traza se queda aquí y en Sentry; la respuesta no la lleva.
		console.error(
			`[alHub] ${c.req.method} ${new URL(c.req.url).pathname} → ${(error as any)?.name || "Error"}: ` +
				`${(error as any)?.message || error}\n${(error as any)?.stack || ""}`,
		);
	}

	const anotado = reportarHubNoDisponible(c.env, {
		tenant_id: tenantId,
		motivo: saturado ? "saturado" : fallo.retryable === true ? "pasajero" : "otro",
		repetida,
		metodo: c.req.method,
		// Como en `tenantAuth` (AUD-32): el principio de la ruta, filtrado antes de recortarlo.
		ruta: acotar(new URL(c.req.url).pathname, scrub, { bytes: 256, filtrado: MAX_FILTRADO }),
		error: String(fallo.message ?? error).slice(0, 300),
	});
	try {
		c.executionCtx.waitUntil(anotado);
	} catch {
		// Sin contexto de ejecución (los tests): perder la anotación no puede tumbar la respuesta.
		void anotado;
	}

	return saturado
		? c.json({ ok: false, code: "external", error: "hub_overloaded" }, 503, {
				"Retry-After": String(ESPERA_SI_SATURADO_S),
			})
		: c.json({ ok: false, code: "external", error: "hub_unavailable" }, 503);
}

/** Pasa la petición, ya autenticada, al TenantHub del negocio y devuelve lo que conteste. */
export const alHub: MiddlewareHandler<{ Bindings: Env; Variables: TenantVars }> = async (c, next) => {
	if (hubLocal() || c.env?.EJECUTAR_EN_EL_HUB !== "1") {
		await next();
		return;
	}
	const identidad: IdentidadDelWorker = {
		tenantId: c.get("tenantId"),
		deviceId: c.get("deviceId"),
		token: c.get("token"),
		licHash: c.get("licHash"),
		rol: c.get("rol"),
	};
	// `tenantAuth` ya leyó el cuerpo para la firma y Hono lo guarda: esto no lo vuelve a leer de la red.
	const cuerpo = c.req.raw.body ? await c.req.arrayBuffer() : undefined;
	// Una petición y un stub nuevos en cada intento: la petición anterior se la llevó el RPC con su
	// cuerpo, y un stub que ha fallado puede haber quedado roto.
	const pedir = async (): Promise<Response> =>
		(await medirTramo("hub-ruta", () =>
			hubDe(c.env, identidad.tenantId).ejecutarRuta(
				new Request(c.req.url, { method: c.req.method, headers: c.req.raw.headers, body: cuerpo }),
				identidad,
			),
		)) as unknown as Response;

	let respuesta: Response;
	try {
		respuesta = await pedir();
	} catch (primero) {
		const fallo = (primero ?? {}) as FalloDelObjeto;
		// Una lectura se repite una vez si el fallo es pasajero. Saturado, no: sería más carga.
		if (fallo.retryable !== true || fallo.overloaded === true || !esLectura(c)) {
			return sinElObjeto(c, identidad.tenantId, primero, false);
		}
		try {
			respuesta = await pedir();
		} catch (segundo) {
			return sinElObjeto(c, identidad.tenantId, segundo, true);
		}
	}
	anotarDesgloseDelHub(respuesta.headers.get("Server-Timing"));
	return respuesta;
};
