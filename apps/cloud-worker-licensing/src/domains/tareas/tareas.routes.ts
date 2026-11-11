// src/domains/tareas/tareas.routes.ts
//
// Subrouter Hono del modulo de tareas. Se monta en /v1/tareas (index.ts).
// Lecturas directas a la base; escrituras por TenantHub con idempotencia.

import { Hono } from "hono";

import type { Env } from "../../env";
import { tenantQuery } from "../../lib/tenantClient";
import { tenantAuth, type TenantVars } from "../../middleware/tenant";

import * as cmd from "./tareas.commands";
import * as q from "./tareas.queries";
import * as S from "./tareas.schemas";
import { badRequest } from "../../server/utils/response";
import { cuerpo } from "../../lib/validacion";
import { apply, parseId } from "../../lib/rutas";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const tareasRoutes = new Hono<Ctx>();

tareasRoutes.use("*", tenantAuth);

// Lecturas

tareasRoutes.get("/trabajadores", async (c) =>
	c.json(await tenantQuery(c, (db) => q.getTrabajadores(db))),
);

tareasRoutes.get("/admin", async (c) =>
	c.json(await tenantQuery(c, (db) => q.getTareasAdmin(db))),
);

// TAR-05. Ojo al orden: esta ruta va antes que `/:id`, que si no la captura como un id de tarea.
tareasRoutes.get("/papelera", async (c) =>
	c.json(await tenantQuery(c, (db) => q.getPapelera(db))),
);

tareasRoutes.get("/mias", async (c) => {
	const idTrabajador = parseId(c.req.query("trabajador"));
	if (idTrabajador == null) return badRequest(c, "id_trabajador_invalido");
	return c.json(
		await tenantQuery(c, (db) =>
			q.getMisTareas(db, idTrabajador),
		),
	);
});

tareasRoutes.get("/:id/asignados", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_tarea_invalido");
	return c.json(
		await tenantQuery(c, (db) =>
			q.getTareaAsignados(db, id),
		),
	);
});

tareasRoutes.get("/:id", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_tarea_invalido");
	return c.json(await tenantQuery(c, (db) => q.getTareaById(db, id)));
});

// Escrituras

tareasRoutes.post("/", cuerpo(S.createTareaSchema), async (c) => {
	const datos = c.req.valid("json");
	// TAR-03: validar que los trabajadores asignados existen antes de aplicar.
	const okTrab = await tenantQuery(c, (db) =>
		q.trabajadoresExisten(db, datos.ids_trabajadores),
	);
	if (!okTrab) return badRequest(c, "trabajador_inexistente");
	const id = await apply(c, cmd.createTarea(datos));
	return c.json({ ok: true, id_tarea: id });
});

tareasRoutes.put("/:id", cuerpo(S.updateTareaSchema), async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_tarea_invalido");
	const datos = c.req.valid("json");
	await apply(c, cmd.updateTarea(id, datos));
	return c.json({ ok: true });
});

tareasRoutes.put("/:id/asignaciones", cuerpo(S.setAsignacionesTareaSchema), async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_tarea_invalido");
	const datos = c.req.valid("json");
	// TAR-03: validar que los trabajadores asignados existen antes de aplicar.
	const okTrab = await tenantQuery(c, (db) =>
		q.trabajadoresExisten(db, datos.ids_trabajadores),
	);
	if (!okTrab) return badRequest(c, "trabajador_inexistente");
	await apply(c, cmd.setAsignacionesTarea(id, datos));
	return c.json({ ok: true });
});

tareasRoutes.post("/:id/restaurar", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_tarea_invalido");
	await apply(c, cmd.restaurarTarea(id));
	return c.json({ ok: true });
});

tareasRoutes.delete("/papelera", async (c) => {
	const borradas = await apply(c, cmd.vaciarPapelera());
	return c.json({ ok: true, borradas: Number(borradas ?? 0) });
});

tareasRoutes.delete("/:id", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_tarea_invalido");
	await apply(c, cmd.deleteTarea(id));
	return c.json({ ok: true });
});

tareasRoutes.post("/:id/finalizar", cuerpo(S.finalizarTareaSchema), async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_tarea_invalido");
	const datos = c.req.valid("json");
	if (!(await tenantQuery(c, (db) => q.estaAsignada(db, id, datos.id_trabajador)))) {
		return c.json({ ok: false, error: "tarea_no_asignada" }, 404);
	}
	await apply(c, cmd.marcarFinalizada(id, datos));
	return c.json({ ok: true });
});
