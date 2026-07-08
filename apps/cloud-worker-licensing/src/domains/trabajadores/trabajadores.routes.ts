// src/domains/trabajadores/trabajadores.routes.ts

import { Hono } from "hono";
import { z } from "zod";

import type { Env } from "../../env";
import { applyViaHub, HubError, type ApplyCommand } from "../../lib/hub";
import { tenantQuery } from "../../lib/tenantClient";
import { tenantAuth, type TenantVars } from "../../middleware/tenant";

import * as cmd from "./trabajadores.commands";
import * as q from "./trabajadores.queries";
import * as S from "./trabajadores.schemas";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const trabajadoresRoutes = new Hono<Ctx>();

trabajadoresRoutes.use("*", tenantAuth);

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

trabajadoresRoutes.get("/roles", async (c) =>
	c.json(await tenantQuery(c.env, c.get("tenantId"), (db) => q.roles(db))),
);

trabajadoresRoutes.get("/turnos", async (c) =>
	c.json(await tenantQuery(c.env, c.get("tenantId"), (db) => q.turnos(db))),
);

trabajadoresRoutes.get("/by-usuario/:id", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_usuario invalido");
	return c.json(await tenantQuery(c.env, c.get("tenantId"), (db) => q.idByUsuario(db, id)));
});

trabajadoresRoutes.get("/horarios/semana", async (c) => {
	const parsed = S.fechaLunesSchema.safeParse({
		fecha_lunes: c.req.query("fecha_lunes"),
	});
	if (!parsed.success) return badRequest(c, "validation_error", parsed.error);
	return c.json(
		await tenantQuery(c.env, c.get("tenantId"), (db) =>
			q.asignacionesSemana(db, parsed.data.fecha_lunes),
		),
	);
});

trabajadoresRoutes.get("/", async (c) =>
	c.json(await tenantQuery(c.env, c.get("tenantId"), (db) => q.all(db))),
);

trabajadoresRoutes.get("/:id", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_trabajador invalido");
	return c.json(await tenantQuery(c.env, c.get("tenantId"), (db) => q.detail(db, id)));
});

trabajadoresRoutes.post("/", async (c) => {
	const p = await parseBody(c, S.trabajadorCreateSchema);
	if (!p.ok) return p.res;
	const id = await apply(c, cmd.createTrabajador(p.data));
	return c.json({ ok: true, id_trabajador: id });
});

trabajadoresRoutes.put("/:id", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_trabajador invalido");
	const p = await parseBody(c, S.trabajadorUpdateSchema);
	if (!p.ok) return p.res;
	await apply(c, cmd.updateTrabajador(id, p.data));
	return c.json({ ok: true });
});

trabajadoresRoutes.post("/horarios/asignaciones", async (c) => {
	const p = await parseBody(c, S.asignacionCreateSchema);
	if (!p.ok) return p.res;
	// TRAB-04: bloquear el mismo turno para el mismo trabajador y día (aunque cambie el área).
	const dup = await tenantQuery(c.env, c.get("tenantId"), (db) =>
		q.existeAsignacionTurno(db, p.data.id_trabajador, p.data.fecha, p.data.id_turno),
	);
	if (dup) {
		return c.json(
			{ error: "asignacion_duplicada", message: "Ese trabajador ya tiene ese turno asignado ese día." },
			409,
		);
	}
	const id = await apply(c, cmd.createAsignacion(p.data));
	return c.json({ ok: true, id_asignacion: id });
});

trabajadoresRoutes.put("/horarios/asignaciones/:id", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_asignacion invalido");
	const p = await parseBody(c, S.asignacionUpdateSchema);
	if (!p.ok) return p.res;
	await apply(c, cmd.updateAsignacion(id, p.data));
	return c.json({ ok: true });
});

trabajadoresRoutes.delete("/horarios/asignaciones/:id", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_asignacion invalido");
	await apply(c, cmd.deleteAsignacion(id));
	return c.json({ ok: true });
});

trabajadoresRoutes.post("/horarios/copy-semana", async (c) => {
	const p = await parseBody(c, S.copySemanaSchema);
	if (!p.ok) return p.res;
	const data = await apply(c, cmd.copySemana(p.data));
	return c.json({ ok: true, inserted: data });
});

trabajadoresRoutes.post("/horarios/predeterminado-desde-semana", async (c) => {
	const p = await parseBody(c, S.fechaLunesSchema);
	if (!p.ok) return p.res;
	const items = await tenantQuery(c.env, c.get("tenantId"), (db) =>
		q.predeterminadoDesdeSemanaItems(db, p.data.fecha_lunes),
	);
	const ok = await apply(
		c,
		cmd.setPredeterminadoDesdeSemana(p.data.fecha_lunes, items),
	);
	return c.json({ ok: Boolean(ok) });
});
