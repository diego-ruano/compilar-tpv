// src/domains/trabajadores/trabajadores.routes.ts

import { Hono } from "hono";

import type { Env } from "../../env";
import { tenantQuery } from "../../lib/tenantClient";
import { tenantAuth, type TenantVars } from "../../middleware/tenant";
import { alHub } from "../../lib/enElHub";

import * as cmd from "./trabajadores.commands";
import * as q from "./trabajadores.queries";
import * as S from "./trabajadores.schemas";
import { badRequest } from "../../server/utils/response";
import { consulta, cuerpo } from "../../lib/validacion";
import { apply, decidirPorEstado, parseId } from "../../lib/rutas";
import { hashPin } from "../login/login.crypto";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const trabajadoresRoutes = new Hono<Ctx>();

trabajadoresRoutes.use("*", tenantAuth, alHub);

trabajadoresRoutes.get("/permisos/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id == null) return badRequest(c, "id_usuario_invalido");
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
	if (id == null) return badRequest(c, "id_usuario_invalido");
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
	if (id == null) return badRequest(c, "id_trabajador_invalido");
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
	if (id == null) return badRequest(c, "id_trabajador_invalido");
	const datos = c.req.valid("json");
	// Que no deje el negocio sin administrador (RI-62) y que la ficha exista (RI-63) lo deciden las
	// guardas del comando, dentro del lote (SYNC-30, SYNC-35): `ultimo_administrador`,
	// `trabajador_no_encontrado`. La Main lo mira dentro de su transacción.
	const passwordHash = datos.pin ? await hashPin(datos.pin) : null;
	await apply(c, cmd.updateTrabajador(id, datos, passwordHash));
	return c.json({ ok: true });
});

// Eliminar a un trabajador: se borra si no tiene historia y se retira si la tiene (`retirado`).
// Que la ficha siga en la plantilla y que no deje el negocio sin administrador lo deciden las
// guardas del comando (SYNC-30); lo que se lee aquí sólo lo construye y dice cómo ha quedado.
trabajadoresRoutes.delete("/:id", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_trabajador_invalido");
	const idUsuario = (await tenantQuery(c, (db) => q.usuarioDeTrabajador(db, id))) ?? "";
	await apply(c, cmd.eliminarTrabajador(id, idUsuario));
	const retirado = idUsuario !== "" && (await tenantQuery(c, (db) => q.usuarioExiste(db, idUsuario)));
	return c.json({ retirado });
});

trabajadoresRoutes.post("/horarios/guardar", cuerpo(S.asignacionGuardarSchema), async (c) => {
	const datos = c.req.valid("json");
	const existente = datos.id_asignacion ? await tenantQuery(c, db => q.grupoAsignacion(db, datos.id_asignacion!)) : null;
	if (datos.id_asignacion && !existente) return c.json({ error: "asignacion_no_encontrada", message: "Asignación no encontrada" }, 404);
	const guardado = await apply(c, cmd.guardarAsignacion(datos, existente));
	// `guardado` es el recuento del primer INSERT. Sin recuento (`null`: un reintento cuyo recuento no
	// se guardó, AUD-26), se mira si quedó como se pidió. Una asignación nueva no tiene guarda (su INSERT
	// siempre escribe); una edición sí: que el miembro principal siga siendo de ese trabajador y día.
	const hecho = await decidirPorEstado(guardado, async () =>
		!datos.id_asignacion || (await tenantQuery(c, (db) => q.asignacionComoSePidio(db, datos))),
	);
	if (!hecho) return c.json({ error: "asignacion_no_encontrada", message: "Asignación no encontrada" }, 404);
	return c.json({ ok: true });
});

// Marcar libre el día de un trabajador: tapa la plantilla. Se quita borrando esa asignación.
trabajadoresRoutes.post("/horarios/libre", cuerpo(S.horarioLibreSchema), async (c) => {
	await apply(c, cmd.marcarLibre(c.req.valid("json")));
	return c.json({ ok: true });
});

trabajadoresRoutes.delete("/horarios/asignaciones/:id", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_asignacion_invalido");
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
