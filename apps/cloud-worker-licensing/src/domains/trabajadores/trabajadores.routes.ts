// src/domains/trabajadores/trabajadores.routes.ts

import { Hono } from "hono";

import type { Env } from "../../env";
import { tenantQuery } from "../../lib/tenantClient";
import { tenantAuth, type TenantVars } from "../../middleware/tenant";

import * as cmd from "./trabajadores.commands";
import * as q from "./trabajadores.queries";
import * as S from "./trabajadores.schemas";
import { badRequest } from "../../server/utils/response";
import { consulta, cuerpo } from "../../lib/validacion";
import { apply, parseId } from "../../lib/rutas";
import { hashPin } from "../login/login.crypto";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const trabajadoresRoutes = new Hono<Ctx>();

trabajadoresRoutes.use("*", tenantAuth);

trabajadoresRoutes.get("/permisos/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id == null) return badRequest(c, "id_usuario invalido");
    return c.json(await tenantQuery(c, (db) => q.permisosUsuario(db, id)));
});

trabajadoresRoutes.get("/roles", async (c) =>
	c.json(await tenantQuery(c, (db) => q.roles(db))),
);

trabajadoresRoutes.get("/turnos", async (c) =>
	c.json(await tenantQuery(c, (db) => q.turnos(db))),
);

trabajadoresRoutes.get("/by-usuario/:id", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_usuario invalido");
	return c.json(await tenantQuery(c, (db) => q.idByUsuario(db, id)));
});

trabajadoresRoutes.get("/horarios/semana", consulta(S.fechaLunesSchema), async (c) => {
	return c.json(
		await tenantQuery(c, (db) =>
			q.asignacionesSemana(db, c.req.valid("query").fecha_lunes),
		),
	);
});

trabajadoresRoutes.get("/", async (c) =>
	c.json(await tenantQuery(c, (db) => q.all(db))),
);

trabajadoresRoutes.get("/:id", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_trabajador invalido");
	return c.json(await tenantQuery(c, (db) => q.detail(db, id)));
});

trabajadoresRoutes.post("/", cuerpo(S.trabajadorCreateSchema), async (c) => {
	const datos = c.req.valid("json");
	// RI-63: llega el PIN y el hash se hace aquí, como la Main en su SQLite.
	const passwordHash = await hashPin(datos.pin);
	const id = await apply(c, cmd.createTrabajador(datos, passwordHash));
	return c.json({ ok: true, id_trabajador: id });
});

trabajadoresRoutes.put("/:id", cuerpo(S.trabajadorUpdateSchema), async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_trabajador invalido");
	const datos = c.req.valid("json");
	// RI-62: comprobación previa, como TRAB-04: los pasos de una transacción del DO no pueden
	// abortarla según lo que lean. La Main la hace dentro de su transacción.
	const sinAdmin = await tenantQuery(c, (db) =>
		q.dejariaSinAdministrador(db, datos.id_usuario, datos.id_rol, datos.estado),
	);
	if (sinAdmin) return c.json({ error: "ultimo_administrador" }, 409);
	const passwordHash = datos.pin ? await hashPin(datos.pin) : null;
	const filas = await apply(c, cmd.updateTrabajador(id, datos, passwordHash));
	// RI-63: un id que no existe respondía `ok`. En un reintento las cuentas llegan a `null` (el
	// resultado guardado no lee la base): eso no es «no existe».
	if (filas?.usuarios === 0 || filas?.trabajadores === 0) {
		return c.json({ error: "trabajador_no_encontrado" }, 404);
	}
	return c.json({ ok: true });
});

trabajadoresRoutes.post("/horarios/asignaciones", cuerpo(S.asignacionCreateSchema), async (c) => {
	const datos = c.req.valid("json");
	// TRAB-04: bloquear el mismo turno para el mismo trabajador y día (aunque cambie el área).
	const dup = await tenantQuery(c, (db) =>
		q.existeAsignacionTurno(db, datos.id_trabajador, datos.fecha, datos.id_turno),
	);
	if (dup) {
		return c.json(
			{ error: "asignacion_duplicada", message: "Ese trabajador ya tiene ese turno asignado ese día." },
			409,
		);
	}
	const id = await apply(c, cmd.createAsignacion(datos));
	return c.json({ ok: true, id_asignacion: id });
});

trabajadoresRoutes.put("/horarios/asignaciones/:id", cuerpo(S.asignacionUpdateSchema), async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_asignacion invalido");
	const datos = c.req.valid("json");
	await apply(c, cmd.updateAsignacion(id, datos));
	return c.json({ ok: true });
});

trabajadoresRoutes.delete("/horarios/asignaciones/:id", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_asignacion invalido");
	await apply(c, cmd.deleteAsignacion(id));
	return c.json({ ok: true });
});

trabajadoresRoutes.post("/horarios/copy-semana", cuerpo(S.copySemanaSchema), async (c) => {
	const datos = c.req.valid("json");
	// TRAB-08: las filas origen se leen antes de construir el comando, para que cada copia lleve su
	// ID ya resuelto en la sentencia que se replica.
	const filas = await tenantQuery(c, (db) =>
		q.filasSemana(db, datos.from_monday),
	);
	const data = await apply(c, cmd.copySemana(datos, filas));
	return c.json({ ok: true, inserted: data });
});

trabajadoresRoutes.post("/horarios/predeterminado-desde-semana", cuerpo(S.fechaLunesSchema), async (c) => {
	const datos = c.req.valid("json");
	const items = await tenantQuery(c, (db) =>
		q.predeterminadoDesdeSemanaItems(db, datos.fecha_lunes),
	);
	const ok = await apply(
		c,
		cmd.setPredeterminadoDesdeSemana(datos.fecha_lunes, items),
	);
	return c.json({ ok: Boolean(ok) });
});
