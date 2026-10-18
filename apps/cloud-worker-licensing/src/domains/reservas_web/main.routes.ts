// src/domains/reservas_web/main.routes.ts
//
// Reservas desde la web (docs/estudios/reservas-web.md): lo que pide la Main. Todo por `tenantAuth`
// y sólo la Main: la configuración de la reserva web es suya.
//
//   POST /v1/reservas-web/clave → { ok, clave, codigo }: la clave pública del negocio (la crea si
//   no tiene) y la línea que se pega en su web.
//   POST /v1/reservas-web/pendientes → { ok, peticiones, hay_mas }: lo que la agenda tiene para la
//   Main (altas y cancelaciones), que pasa a entregado.
//   POST /v1/reservas-web/recogidas { resultados } → { ok, apuntadas }: cómo le ha ido con cada una.
//
// La Main pide las pendientes al conectar, al terminar una recuperación y cuando el `TenantHub` le
// manda `{"type":"reservas_web"}` (docs/estudios/reservas-web.md §5.4).

import { Hono } from "hono";

import type { Env } from "../../env";
import { soloLaMain, tenantAuth, type TenantVars } from "../../middleware/tenant";
import { agendaDe } from "../../durableObjects/agendaWeb";
import { cuerpo } from "../../lib/validacion";
import { getDb } from "../../server/db";
import { claveDelNegocio, codigoParaLaWeb } from "./claves";
import { recogidasSchema } from "./reservasWeb.schemas";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const reservasWebMainRoutes = new Hono<Ctx>();

reservasWebMainRoutes.use("*", tenantAuth);

reservasWebMainRoutes.post("/clave", soloLaMain("forbidden_not_tpv", 403), async (c) => {
	const clave = await claveDelNegocio(getDb(c.env), c.get("tenantId"), Date.now());
	// El widget se sirve desde este mismo worker: el origen de la petición es el suyo.
	const codigo = codigoParaLaWeb(new URL(c.req.url).origin, clave);
	return c.json({ ok: true, clave, codigo });
});

reservasWebMainRoutes.post("/pendientes", soloLaMain("forbidden_not_tpv", 403), async (c) => {
	const tenantId = c.get("tenantId");
	return c.json(await agendaDe(c.env, tenantId).pendientes({ tenantId }));
});

reservasWebMainRoutes.post(
	"/recogidas",
	soloLaMain("forbidden_not_tpv", 403),
	cuerpo(recogidasSchema),
	async (c) => {
		const tenantId = c.get("tenantId");
		const { resultados } = c.req.valid("json");
		return c.json(await agendaDe(c.env, tenantId).recogidas({ tenantId, resultados }));
	},
);
