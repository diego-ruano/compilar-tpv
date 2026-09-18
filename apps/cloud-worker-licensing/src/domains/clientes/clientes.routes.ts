// src/domains/clientes/clientes.routes.ts

import { Hono } from "hono";
import { z } from "zod";

import type { Env } from "../../env";
import { applyViaHub, HubError, type ApplyCommand } from "../../lib/hub";
import { tenantQuery } from "../../lib/tenantClient";
import { tenantAuth, type TenantVars } from "../../middleware/tenant";

import * as cmd from "./clientes.commands";
import * as q from "./clientes.queries";
import * as S from "./clientes.schemas";
import { badRequest } from "../../server/utils/response";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const clientesRoutes = new Hono<Ctx>();

clientesRoutes.use("*", tenantAuth);

function parseId(raw: string | undefined): string | null {
	const t = (raw ?? "").trim();
	return t.length ? t : null;
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
		clientNow: c.req.header("X-Client-Now") || undefined,
		opId,
		commandName: built.commandName,
		command: built.command,
		cloudPayload: built.cloudPayload,
	});
}

clientesRoutes.get("/overview", async (c) => {
	const ranking = c.req.query("ranking") || "todos";
	return c.json(
		await tenantQuery(c, (db) => q.overview(db, ranking)),
	);
});

clientesRoutes.get("/:id/form", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_cliente invalido");
	return c.json(await tenantQuery(c, (db) => q.form(db, id)));
});

clientesRoutes.post("/", async (c) => {
	const p = await parseBody(c, S.createClienteSchema);
	if (!p.ok) return p.res;
	// CLI-04: rechazar email duplicado con un 409 limpio antes de aplicar (el índice
	// único ux_clientes_email es el backstop real).
	if (p.data.email) {
		const dup = await tenantQuery(c, (db) =>
			q.emailEnUso(db, p.data.email!, p.data.id_cliente),
		);
		if (dup) return c.json({ error: "email_duplicado" }, 409);
	}
	const id = await apply(c, cmd.createCliente(p.data));
	return c.json({ ok: true, id_cliente: id });
});

clientesRoutes.put("/:id", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_cliente invalido");
	const p = await parseBody(c, S.updateClienteSchema);
	if (!p.ok) return p.res;
	if (p.data.email) {
		const dup = await tenantQuery(c, (db) =>
			q.emailEnUso(db, p.data.email!, id),
		);
		if (dup) return c.json({ error: "email_duplicado" }, 409);
	}
	await apply(c, cmd.updateCliente(id, p.data));
	return c.json({ ok: true });
});
