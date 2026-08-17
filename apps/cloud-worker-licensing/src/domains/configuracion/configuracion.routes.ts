// src/domains/configuracion/configuracion.routes.ts

import { Hono } from "hono";
import { z } from "zod";

import type { Env } from "../../env";
import { applyViaHub, HubError, type ApplyCommand } from "../../lib/hub";
import { tenantQuery } from "../../lib/tenantClient";
import { tenantAuth, type TenantVars } from "../../middleware/tenant";

import * as cmd from "./configuracion.commands";
import * as q from "./configuracion.queries";
import { configPatchSchema } from "./configuracion.schemas";
import { badRequest } from "../../server/utils/response";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const configuracionRoutes = new Hono<Ctx>();

configuracionRoutes.use("*", tenantAuth);

async function parseBody<S extends z.ZodTypeAny>(
	c: any,
	schema: S,
): Promise<{ ok: true; data: z.infer<S> } | { ok: false; res: Response }> {
	const body = await c.req.json().catch(() => null);
	const parsed = schema.safeParse(body);
	if (!parsed.success) {
		return { ok: false, res: badRequest(c, "validation_error", parsed.error) };
	}
	return { ok: true, data: parsed.data };
}

async function apply(
	c: any,
	built: { commandName: string; command: ApplyCommand; cloudPayload: any },
): Promise<any> {
	const opId = (c.req.header("X-Idempotency-Key") || "").trim();
	if (!opId) throw new HubError("missing_op_id", 400);
	return applyViaHub(c.env, {
		tenantId: c.get("tenantId"),
		deviceId: c.get("deviceId"),
		clientNow: c.req.header("X-Client-Now") || undefined,
		opId,
		commandName: built.commandName,
		command: built.command,
		cloudPayload: built.cloudPayload,
	});
}

configuracionRoutes.get("/contact", async (c) =>
	c.json(await tenantQuery(c.env, c.get("tenantId"), (db) => q.getContact(db))),
);

configuracionRoutes.patch("/contact", async (c) => {
	const p = await parseBody(c, configPatchSchema);
	if (!p.ok) return p.res;
	await apply(c, cmd.patchContact(p.data.patch));
	return c.json({ ok: true });
});

configuracionRoutes.get("/business", async (c) =>
	c.json(await tenantQuery(c.env, c.get("tenantId"), (db) => q.getBusiness(db))),
);

configuracionRoutes.get("/ticket", async (c) =>
	c.json(await tenantQuery(c.env, c.get("tenantId"), (db) => q.getTicket(db))),
);

configuracionRoutes.patch("/business", async (c) => {
	const p = await parseBody(c, configPatchSchema);
	if (!p.ok) return p.res;
	await apply(c, cmd.patchBusiness(p.data.patch));
	return c.json({ ok: true });
});

configuracionRoutes.patch("/ticket", async (c) => {
	const p = await parseBody(c, configPatchSchema);
	if (!p.ok) return p.res;
	await apply(c, cmd.patchTicket(p.data.patch));
	return c.json({ ok: true });
});
