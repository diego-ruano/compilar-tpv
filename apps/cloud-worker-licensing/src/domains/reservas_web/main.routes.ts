// src/domains/reservas_web/main.routes.ts
//
// Reservas desde la web (docs/estudios/reservas-web.md): lo que pide la Main. Todo por `tenantAuth`
// y sólo la Main: la configuración de la reserva web es suya.
//
//   POST /v1/reservas-web/clave → { ok, clave, codigo }: la clave pública del negocio (la crea si
//   no tiene) y la línea que se pega en su web.

import { Hono } from "hono";

import type { Env } from "../../env";
import { soloLaMain, tenantAuth, type TenantVars } from "../../middleware/tenant";
import { getDb } from "../../server/db";
import { claveDelNegocio, codigoParaLaWeb } from "./claves";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const reservasWebMainRoutes = new Hono<Ctx>();

reservasWebMainRoutes.use("*", tenantAuth);

reservasWebMainRoutes.post("/clave", soloLaMain("forbidden_not_tpv", 403), async (c) => {
	const clave = await claveDelNegocio(getDb(c.env), c.get("tenantId"), Date.now());
	// El widget se sirve desde este mismo worker: el origen de la petición es el suyo.
	const codigo = codigoParaLaWeb(new URL(c.req.url).origin, clave);
	return c.json({ ok: true, clave, codigo });
});
