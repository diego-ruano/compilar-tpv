// src/domains/cuentas/cuentas.routes.ts

import { Hono } from "hono";
import { z } from "zod";

import type { Env } from "../../env";
import { applyViaHub, HubError, type ApplyCommand } from "../../lib/hub";
import { tenantQuery } from "../../lib/tenantClient";
import { tenantAuth, type TenantVars } from "../../middleware/tenant";

import * as cmd from "./cuentas.commands";
import * as q from "./cuentas.queries";
import * as S from "./cuentas.schemas";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const cuentasRoutes = new Hono<Ctx>();

cuentasRoutes.use("*", tenantAuth);

function badRequest(c: any, error: string, err?: z.ZodError) {
	return c.json({ error, issues: err?.issues }, 400);
}

function parseId(raw: string | undefined): number | null {
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : null;
}

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
		opId,
		commandName: built.commandName,
		command: built.command,
		cloudPayload: built.cloudPayload,
	});
}

cuentasRoutes.get("/entradas", async (c) => {
	const p = S.rangoSchema.parse({
		del: c.req.query("del"),
		al: c.req.query("al"),
	});
	return c.json(
		await tenantQuery(c.env, c.get("tenantId"), (db) =>
			q.entradas(db, p.del, p.al),
		),
	);
});

cuentasRoutes.get("/salidas", async (c) => {
	const p = S.rangoSchema.parse({
		del: c.req.query("del"),
		al: c.req.query("al"),
	});
	return c.json(
		await tenantQuery(c.env, c.get("tenantId"), (db) => q.salidas(db, p.del, p.al)),
	);
});

cuentasRoutes.post("/gastos", async (c) => {
	const p = await parseBody(c, S.createGastoSchema);
	if (!p.ok) return p.res;
	const id = await apply(c, cmd.createGasto(p.data));
	return c.json({ ok: true, id_gasto: id });
});

cuentasRoutes.put("/gastos/:id", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_gasto invalido");
	const p = await parseBody(c, S.updateGastoSchema);
	if (!p.ok) return p.res;
	await apply(c, cmd.updateGasto(id, p.data));
	return c.json({ ok: true });
});

cuentasRoutes.delete("/gastos/:id", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_gasto invalido");
	await apply(c, cmd.deleteGasto(id));
	return c.json({ ok: true });
});

cuentasRoutes.put("/pagos/:id", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_pago invalido");
	const p = await parseBody(c, S.updatePagoSchema);
	if (!p.ok) return p.res;
	await apply(c, cmd.updatePago(id, p.data));
	return c.json({ ok: true });
});

cuentasRoutes.delete("/pagos/:id", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_pago invalido");
	await apply(c, cmd.deletePago(id));
	return c.json({ ok: true });
});
