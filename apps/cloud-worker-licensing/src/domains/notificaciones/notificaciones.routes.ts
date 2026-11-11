// src/domains/notificaciones/notificaciones.routes.ts
//
// Subrouter Hono del módulo de notificaciones. Se monta en /v1/notificaciones (index.ts).
// Lecturas directas a la base; escrituras por TenantHub (idempotencia + broadcast por WebSocket).

import { Hono } from "hono";

import type { Env } from "../../env";
import { tenantQuery } from "../../lib/tenantClient";
import { tenantAuth, type TenantVars } from "../../middleware/tenant";

import * as cmd from "./notificaciones.commands";
import * as q from "./notificaciones.queries";
import * as S from "./notificaciones.schemas";
import { badRequest } from "../../server/utils/response";
import { cuerpo } from "../../lib/validacion";
import { apply, parseId } from "../../lib/rutas";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const notificacionesRoutes = new Hono<Ctx>();

notificacionesRoutes.use("*", tenantAuth);

// Lecturas

notificacionesRoutes.get("/", async (c) => {
	const uid = parseId(c.req.query("usuario"));
	if (uid == null) return badRequest(c, "id_usuario_invalido");
	const soloNoLeidas = c.req.query("solo_no_leidas") === "true";
	return c.json(
		await tenantQuery(c, (db) => q.listar(db, uid, soloNoLeidas)),
	);
});

notificacionesRoutes.get("/papelera", async (c) => {
	const uid = parseId(c.req.query("usuario"));
	if (uid == null) return badRequest(c, "id_usuario_invalido");
	return c.json(
		await tenantQuery(c, (db) => q.listarPapelera(db, uid)),
	);
});

notificacionesRoutes.get("/count", async (c) => {
	const uid = parseId(c.req.query("usuario"));
	if (uid == null) return badRequest(c, "id_usuario_invalido");
	const count = await tenantQuery(c, (db) =>
		q.contarNoLeidas(db, uid),
	);
	return c.json({ count });
});

// Escrituras

notificacionesRoutes.post("/", cuerpo(S.crearNotificacionSchema), async (c) => {
	const datos = c.req.valid("json");

	// Con clave de dedupe y una activa con ella no se crea otra: se actualiza si ha cambiado (RI-12,
	// espejo de `emitir` en la Main) y se devuelve su id.
	const nueva = cmd.normalizar(datos);
	if (nueva.clave_dedupe) {
		const activa = await tenantQuery(c, (db) => q.activaPorClave(db, nueva.clave_dedupe as string));
		if (activa) {
			const cambio = cmd.actualizar(activa.id, activa.contenido, nueva);
			if (cambio) await apply(c, cambio);
			return c.json({ ok: true, id_notificacion: activa.id });
		}
	}

	const id = await apply(c, cmd.crear(datos));
	return c.json({ ok: true, id_notificacion: id });
});

notificacionesRoutes.post("/leer-todas", cuerpo(S.marcarTodasSchema), async (c) => {
	const datos = c.req.valid("json");

	const ids = await tenantQuery(c, (db) =>
		q.idsNoLeidas(db, datos.id_usuario),
	);
	if (ids.length === 0) return c.json({ ok: true, marcadas: 0 });

	await apply(c, cmd.marcarLeidasBatch(ids, datos.id_usuario));
	return c.json({ ok: true, marcadas: ids.length });
});

notificacionesRoutes.post("/resolver", cuerpo(S.resolverSchema), async (c) => {
	const datos = c.req.valid("json");
	// Sin nada activo no se escribe: quien resuelve lo hace en cada comprobación periódica, y cada
	// escritura viaja a la Main y a las demás Handy (RI-12).
	const activa = await tenantQuery(c, (db) => q.activaPorClave(db, datos.clave_dedupe));
	if (!activa) return c.json({ ok: true });
	await apply(c, cmd.resolverPorClave(datos.clave_dedupe));
	return c.json({ ok: true });
});

notificacionesRoutes.post("/:id/descartar", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_notificacion_invalido");
	await apply(c, cmd.descartar(id));
	return c.json({ ok: true });
});

notificacionesRoutes.post("/:id/restaurar", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_notificacion_invalido");
	await apply(c, cmd.restaurar(id));
	return c.json({ ok: true });
});

notificacionesRoutes.delete("/:id", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_notificacion_invalido");
	await apply(c, cmd.eliminar(id));
	return c.json({ ok: true });
});

notificacionesRoutes.post("/:id/leer", cuerpo(S.marcarLeidaSchema), async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_notificacion_invalido");
	const datos = c.req.valid("json");
	await apply(c, cmd.marcarLeida(id, datos.id_usuario));
	return c.json({ ok: true });
});
