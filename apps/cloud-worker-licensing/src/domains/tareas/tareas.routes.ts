// src/domains/tareas/tareas.routes.ts
//
// Subrouter Hono del modulo de tareas. Se monta en /v1/tareas (index.ts).
// Lecturas directas a Turso; escrituras por TenantHub con idempotencia.

import { Hono } from "hono";
import { z } from "zod";

import type { Env } from "../../env";
import { applyViaHub, HubError, type ApplyCommand } from "../../lib/hub";
import { tenantQuery } from "../../lib/tenantClient";
import { tenantAuth, type TenantVars } from "../../middleware/tenant";

import * as cmd from "./tareas.commands";
import * as q from "./tareas.queries";
import * as S from "./tareas.schemas";
import { badRequest } from "../../server/utils/response";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const tareasRoutes = new Hono<Ctx>();

tareasRoutes.use("*", tenantAuth);

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

// Lecturas

tareasRoutes.get("/trabajadores", async (c) =>
	c.json(await tenantQuery(c.env, c.get("tenantId"), (db) => q.getTrabajadores(db))),
);

tareasRoutes.get("/admin", async (c) =>
	c.json(await tenantQuery(c.env, c.get("tenantId"), (db) => q.getTareasAdmin(db))),
);

tareasRoutes.get("/mias", async (c) => {
	const idTrabajador = parseId(c.req.query("trabajador"));
	if (idTrabajador == null) return badRequest(c, "id_trabajador invalido");
	return c.json(
		await tenantQuery(c.env, c.get("tenantId"), (db) =>
			q.getMisTareas(db, idTrabajador),
		),
	);
});

tareasRoutes.get("/:id/asignados", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_tarea invalido");
	return c.json(
		await tenantQuery(c.env, c.get("tenantId"), (db) =>
			q.getTareaAsignados(db, id),
		),
	);
});

tareasRoutes.get("/:id", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_tarea invalido");
	return c.json(await tenantQuery(c.env, c.get("tenantId"), (db) => q.getTareaById(db, id)));
});

// Escrituras

tareasRoutes.post("/", async (c) => {
	const p = await parseBody(c, S.createTareaSchema);
	if (!p.ok) return p.res;
	// TAR-03: validar que los trabajadores asignados existen antes de aplicar.
	const okTrab = await tenantQuery(c.env, c.get("tenantId"), (db) =>
		q.trabajadoresExisten(db, p.data.ids_trabajadores),
	);
	if (!okTrab) return badRequest(c, "trabajador_inexistente");
	const id = await apply(c, cmd.createTarea(p.data));
	return c.json({ ok: true, id_tarea: id });
});

tareasRoutes.put("/:id", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_tarea invalido");
	const p = await parseBody(c, S.updateTareaSchema);
	if (!p.ok) return p.res;
	await apply(c, cmd.updateTarea(id, p.data));
	return c.json({ ok: true });
});

tareasRoutes.put("/:id/asignaciones", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_tarea invalido");
	const p = await parseBody(c, S.setAsignacionesTareaSchema);
	if (!p.ok) return p.res;
	// TAR-03: validar que los trabajadores asignados existen antes de aplicar.
	const okTrab = await tenantQuery(c.env, c.get("tenantId"), (db) =>
		q.trabajadoresExisten(db, p.data.ids_trabajadores),
	);
	if (!okTrab) return badRequest(c, "trabajador_inexistente");
	await apply(c, cmd.setAsignacionesTarea(id, p.data));
	return c.json({ ok: true });
});

tareasRoutes.delete("/:id", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_tarea invalido");
	await apply(c, cmd.deleteTarea(id));
	return c.json({ ok: true });
});

tareasRoutes.post("/:id/finalizar", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_tarea invalido");
	const p = await parseBody(c, S.finalizarTareaSchema);
	if (!p.ok) return p.res;
	await apply(c, cmd.marcarFinalizada(id, p.data));
	return c.json({ ok: true });
});
