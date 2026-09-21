// src/domains/pairing/pairing.routes.ts
//
// Las rutas del emparejamiento (pairing) Main ↔ Handy, montadas bajo `/v1/pair` (ver
// src/index.ts).
//
// ARQ-03. Antes esto era un subrouter que delegaba en siete handlers con firma
// `(Request, env, db)`, y cada uno traía su propia copia de `readJsonSafe`, de `rowsAffected`, de
// `isAuthError` —doce `msg.includes(...)` repetidos cinco veces— y un `try/catch` que se comía la
// excepción para devolver un 500 con el `stack` dentro. Ahora:
//
//   · **La autenticación es `tenantAuth`**, el mismo middleware que usan los dominios de negocio,
//     en vez de `buildTenantContext` + clasificación del error por el texto del mensaje. Y con él
//     viene el veto de licencia (REV-12), que estas rutas eran las únicas autenticadas en no
//     tener: con la licencia anulada, una Main seguía pudiendo emitir códigos y aprobar Handys.
//   · **El cuerpo lo valida `pairing.schemas.ts`**, no un `if` por campo dentro del handler.
//   · **El 500 ya no se captura aquí**: sube a `app.onError`, que es el único sitio que avisa a
//     Sentry y deja traza en `wrangler tail`. Mientras cada handler lo atrapaba, un fallo interno
//     del emparejamiento era invisible para nosotros.
//
// Auth por ruta y no `use("*")`:
//   · `claim`, `fetch-token` y `cancel` son ANÓNIMOS (los usa la Handy antes de tener token):
//     operan contra la base central validando código, secreto y firma.
//   · `create`, `pending`, `approve` y `reject` son de la MAIN: token + device-proof + rol `tpv`.

import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";

import type { Env } from "../../env";
import { cuerpoConIdentificador } from "../../lib/validacion";
import { soloLaMain, tenantAuth, type TenantVars } from "../../middleware/tenant";
import { getDb } from "../../server/db";
import { ipDeLaPeticion } from "./pairing.avisos";
import { demasiadasPeticiones, entregarToken, reclamarCodigo, soltarCodigo } from "./pairing.handy";
import { aprobarSolicitud, crearCodigo, rechazarSolicitud, solicitudesPendientes } from "./pairing.main";
import { pasaElFiltroExterior } from "./pairing.intentos";
import { responder } from "./pairing.resultado";
import * as S from "./pairing.schemas";

type Ctx = { Bindings: Env; Variables: Partial<TenantVars> };

export const pairingRoutes = new Hono<Ctx>();

/**
 * El cortafuegos de coste, DELANTE del validador del cuerpo a propósito: lo que se quiere es
 * soltar el lastre cuanto antes, y para esto sólo hace falta la IP. Un cliente roto que mande
 * basura a 20 por minuto también sobra, aunque sus 400 no cuenten como intento.
 */
const filtroExterior: MiddlewareHandler<Ctx> = async (c, next) => {
	if (!(await pasaElFiltroExterior(c.env, ipDeLaPeticion(c.req.raw)))) {
		return responder(c, demasiadasPeticiones());
	}
	await next();
};

/** La Main que habla por estas rutas: token + device-proof + licencia viva + rol `tpv`. */
const laMain = [tenantAuth, soloLaMain("forbidden_not_tpv", 401)] as const;

// ---- Handy (anónimos, firmados por el dispositivo que reclamó) ----

pairingRoutes.post("/claim", filtroExterior, cuerpoConIdentificador(S.claimSchema), async (c) =>
	responder(
		c,
		await reclamarCodigo(
			getDb(c.env),
			c.env,
			c.req.valid("json"),
			ipDeLaPeticion(c.req.raw),
			Date.now(),
		),
	),
);

pairingRoutes.post("/fetch-token", cuerpoConIdentificador(S.fetchTokenSchema), async (c) =>
	responder(c, await entregarToken(getDb(c.env), c.env, c.req.valid("json"), Date.now())),
);

pairingRoutes.post("/cancel", cuerpoConIdentificador(S.cancelSchema), async (c) =>
	responder(c, await soltarCodigo(getDb(c.env), c.env, c.req.valid("json"), Date.now())),
);

// ---- Main / TPV ----

pairingRoutes.post("/create", ...laMain, async (c) =>
	responder(
		c,
		await crearCodigo(getDb(c.env), c.env, c.get("tenantId")!, c.get("deviceId")!, Date.now()),
	),
);

pairingRoutes.post("/pending", ...laMain, async (c) =>
	responder(c, await solicitudesPendientes(getDb(c.env), c.get("tenantId")!, Date.now())),
);

pairingRoutes.post("/approve", ...laMain, cuerpoConIdentificador(S.pairCodeSchema), async (c) =>
	responder(
		c,
		await aprobarSolicitud(getDb(c.env), c.get("tenantId")!, c.req.valid("json").pairCode, Date.now()),
	),
);

pairingRoutes.post("/reject", ...laMain, cuerpoConIdentificador(S.pairCodeSchema), async (c) =>
	responder(
		c,
		await rechazarSolicitud(getDb(c.env), c.get("tenantId")!, c.req.valid("json").pairCode, Date.now()),
	),
);
