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

import type { MiddlewareHandler } from "hono";

import type { Env } from "../env";
import type { IdentidadDelWorker } from "../durableObjects/tenantHub.rpc";
import type { TenantVars } from "../middleware/tenant";
import { anotarDesgloseDelHub, medirTramo } from "../observability/tiempos";
import { hubDe } from "./hub";
import { hubLocal } from "./hubLocal";

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
	const peticion = new Request(c.req.url, { method: c.req.method, headers: c.req.raw.headers, body: cuerpo });
	const respuesta = (await medirTramo("hub-ruta", () =>
		hubDe(c.env, identidad.tenantId).ejecutarRuta(peticion, identidad),
	)) as unknown as Response;
	anotarDesgloseDelHub(respuesta.headers.get("Server-Timing"));
	return respuesta;
};
