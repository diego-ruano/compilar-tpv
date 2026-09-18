// src/domains/notificaciones/notificaciones.routes.ts
//
// Subrouter Hono del módulo de notificaciones. Se monta en /v1/notificaciones (index.ts).
// Lecturas directas a Turso; escrituras por TenantHub (idempotencia + broadcast por WebSocket).

import { Hono } from "hono";
import { z } from "zod";

import type { Env } from "../../env";
import { applyViaHub, HubError, type ApplyCommand } from "../../lib/hub";
import { tenantQuery } from "../../lib/tenantClient";
import { tenantAuth, type TenantVars } from "../../middleware/tenant";

import * as cmd from "./notificaciones.commands";
import * as q from "./notificaciones.queries";
import * as S from "./notificaciones.schemas";
import { badRequest } from "../../server/utils/response";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const notificacionesRoutes = new Hono<Ctx>();

notificacionesRoutes.use("*", tenantAuth);

function parseId(raw: string | undefined): string | null {
	const t = (raw ?? "").trim();
	return t.length ? t : null;
}

async function parseBody<Sch extends z.ZodTypeAny>(
	c: any,
	schema: Sch,
): Promise<{ ok: true; data: z.infer<Sch> } | { ok: false; res: Response }> {
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

// Lecturas

notificacionesRoutes.get("/", async (c) => {
	const uid = parseId(c.req.query("usuario"));
	if (uid == null) return badRequest(c, "id_usuario invalido");
	const soloNoLeidas = c.req.query("solo_no_leidas") === "true";
	return c.json(
		await tenantQuery(c, (db) => q.listar(db, uid, soloNoLeidas)),
	);
});

notificacionesRoutes.get("/papelera", async (c) => {
	const uid = parseId(c.req.query("usuario"));
	if (uid == null) return badRequest(c, "id_usuario invalido");
	return c.json(
		await tenantQuery(c, (db) => q.listarPapelera(db, uid)),
	);
});

notificacionesRoutes.get("/count", async (c) => {
	const uid = parseId(c.req.query("usuario"));
	if (uid == null) return badRequest(c, "id_usuario invalido");
	const count = await tenantQuery(c, (db) =>
		q.contarNoLeidas(db, uid),
	);
	return c.json({ count });
});

// Escrituras

notificacionesRoutes.post("/", async (c) => {
	const p = await parseBody(c, S.crearNotificacionSchema);
	if (!p.ok) return p.res;

	// Idempotencia por clave de dedupe: si ya hay una activa con esa clave, devolvemos su id sin
	// crear otra (espejo de la emisión Local-First del repo SQLite).
	if (p.data.clave_dedupe) {
		const existing = await tenantQuery(c, (db) =>
			q.idActivaPorClave(db, p.data.clave_dedupe as string),
		);
		if (existing) return c.json({ ok: true, id_notificacion: existing });
	}

	const id = await apply(c, cmd.crear(p.data));
	return c.json({ ok: true, id_notificacion: id });
});

notificacionesRoutes.post("/leer-todas", async (c) => {
	const p = await parseBody(c, S.marcarTodasSchema);
	if (!p.ok) return p.res;

	const ids = await tenantQuery(c, (db) =>
		q.idsNoLeidas(db, p.data.id_usuario),
	);
	if (ids.length === 0) return c.json({ ok: true, marcadas: 0 });

	await apply(c, cmd.marcarLeidasBatch(ids, p.data.id_usuario));
	return c.json({ ok: true, marcadas: ids.length });
});

notificacionesRoutes.post("/resolver", async (c) => {
	const p = await parseBody(c, S.resolverSchema);
	if (!p.ok) return p.res;
	await apply(c, cmd.resolverPorClave(p.data.clave_dedupe));
	return c.json({ ok: true });
});

notificacionesRoutes.post("/:id/descartar", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_notificacion invalido");
	await apply(c, cmd.descartar(id));
	return c.json({ ok: true });
});

notificacionesRoutes.post("/:id/restaurar", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_notificacion invalido");
	await apply(c, cmd.restaurar(id));
	return c.json({ ok: true });
});

notificacionesRoutes.delete("/:id", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_notificacion invalido");
	await apply(c, cmd.eliminar(id));
	return c.json({ ok: true });
});

notificacionesRoutes.post("/:id/leer", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_notificacion invalido");
	const p = await parseBody(c, S.marcarLeidaSchema);
	if (!p.ok) return p.res;
	await apply(c, cmd.marcarLeida(id, p.data.id_usuario));
	return c.json({ ok: true });
});
