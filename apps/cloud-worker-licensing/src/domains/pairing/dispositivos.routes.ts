// src/domains/pairing/dispositivos.routes.ts
//
// `/v1/device/*`: ver y desvincular los Handy del negocio. Va con el emparejamiento porque es la
// otra mitad de la misma pantalla (Configuración → Vincular Handy).
//
// Estaban montadas a pelo en `index.ts`, con dos handlers que repetían el mismo `buildTenantContext`
// + `isAuthError` que los de pairing. Ahora son un subrouter como el resto (ARQ-03).

import { Hono } from "hono";

import type { Env } from "../../env";
import { cuerpoConIdentificador } from "../../lib/validacion";
import { soloLaMainVigente, tenantAuth, type TenantVars } from "../../middleware/tenant";
import { getDb } from "../../server/db";
import { listarDispositivos, revocarDispositivo } from "./dispositivos";
import { responder } from "./pairing.resultado";
import { revocarSchema } from "./pairing.schemas";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const dispositivosRoutes = new Hono<Ctx>();

// `forbidden_not_main` y no `forbidden_not_tpv`: es el identificador que estas dos rutas ya
// devolvían, y lo que ve el cliente es contrato.
dispositivosRoutes.use("*", tenantAuth, soloLaMainVigente("forbidden_not_main", 401));

dispositivosRoutes.post("/list", async (c) =>
	responder(c, await listarDispositivos(getDb(c.env), c.get("tenantId"))),
);

dispositivosRoutes.post("/revoke", cuerpoConIdentificador(revocarSchema), async (c) =>
	responder(
		c,
		await revocarDispositivo(
			getDb(c.env),
			c.env,
			c.get("tenantId"),
			c.get("deviceId"),
			c.req.valid("json").deviceId,
			Date.now(),
		),
	),
);
