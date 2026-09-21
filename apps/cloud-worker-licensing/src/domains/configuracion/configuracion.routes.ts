// src/domains/configuracion/configuracion.routes.ts

import { Hono } from "hono";

import type { Env } from "../../env";
import { tenantQuery } from "../../lib/tenantClient";
import { tenantAuth, type TenantVars } from "../../middleware/tenant";

import * as cmd from "./configuracion.commands";
import * as q from "./configuracion.queries";
import { configPatchSchema } from "./configuracion.schemas";
import { cuerpo } from "../../lib/validacion";
import { apply } from "../../lib/rutas";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const configuracionRoutes = new Hono<Ctx>();

configuracionRoutes.use("*", tenantAuth);

configuracionRoutes.get("/contact", async (c) =>
	c.json(await tenantQuery(c, (db) => q.getContact(db))),
);

configuracionRoutes.patch("/contact", cuerpo(configPatchSchema), async (c) => {
	const datos = c.req.valid("json");
	await apply(c, cmd.patchContact(datos.patch));
	return c.json({ ok: true });
});

configuracionRoutes.get("/business", async (c) =>
	c.json(await tenantQuery(c, (db) => q.getBusiness(db))),
);

configuracionRoutes.get("/ticket", async (c) =>
	c.json(await tenantQuery(c, (db) => q.getTicket(db))),
);

configuracionRoutes.patch("/business", cuerpo(configPatchSchema), async (c) => {
	const datos = c.req.valid("json");
	await apply(c, cmd.patchBusiness(datos.patch));
	return c.json({ ok: true });
});

configuracionRoutes.patch("/ticket", cuerpo(configPatchSchema), async (c) => {
	const datos = c.req.valid("json");
	await apply(c, cmd.patchTicket(datos.patch));
	return c.json({ ok: true });
});
