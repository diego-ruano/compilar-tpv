// src/domains/reservas/reservas.routes.ts

import { Hono } from "hono";
import { z } from "zod";

import type { Env } from "../../env";
import { applyViaHub, HubError, type ApplyCommand } from "../../lib/hub";
import { tenantQuery } from "../../lib/tenantClient";
import { tenantAuth, type TenantVars } from "../../middleware/tenant";

import * as cmd from "./reservas.commands";
import * as q from "./reservas.queries";
import * as S from "./reservas.schemas";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const reservasRoutes = new Hono<Ctx>();

reservasRoutes.use("*", tenantAuth);

function badRequest(c: any, error: string, err?: z.ZodError) {
	return c.json({ error, issues: err?.issues }, 400);
}

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

reservasRoutes.get("/meta", async (c) =>
	c.json(await tenantQuery(c.env, c.get("tenantId"), (db) => q.meta(db))),
);

reservasRoutes.get("/mes", async (c) => {
	const parsed = S.mesQuerySchema.safeParse({
		desde: c.req.query("desde"),
		hasta: c.req.query("hasta"),
	});
	if (!parsed.success) return badRequest(c, "validation_error", parsed.error);
	return c.json(
		await tenantQuery(c.env, c.get("tenantId"), (db) =>
			q.mes(db, parsed.data.desde, parsed.data.hasta),
		),
	);
});

reservasRoutes.post("/", async (c) => {
	const p = await parseBody(c, S.reservaSaveSchema);
	if (!p.ok) return p.res;

	// RES-02: rechazar el doble booking del mismo hueco exacto (mesa+día+hora) antes de aplicar.
	const solapa = await tenantQuery(c.env, c.get("tenantId"), (db) =>
		q.haySolapeReserva(db, p.data.id_mesa, p.data.dia_ymd, p.data.hora, p.data.id_reserva ?? null),
	);
	if (solapa) {
		return c.json(
			{ error: "reserva_solapada", message: "Ya existe una reserva en esa mesa para ese día y hora." },
			409,
		);
	}

	const cliente = await tenantQuery(c.env, c.get("tenantId"), (db) =>
		q.findClienteReserva(db, p.data.email, p.data.telefono),
	);
	const id = await apply(c, cmd.saveReserva(p.data, cliente));
	return c.json({ ok: true, id_reserva: id });
});

reservasRoutes.delete("/:id", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_reserva invalido");
	await apply(c, cmd.deleteReserva(id));
	return c.json({ ok: true });
});
