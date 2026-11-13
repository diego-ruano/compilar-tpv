// src/domains/notificaciones/notificaciones.routes.ts
//
// Subrouter Hono del módulo de notificaciones. Se monta en /v1/notificaciones (index.ts).
// Lecturas directas a la base; escrituras por TenantHub (idempotencia + broadcast por WebSocket).

import { Hono } from "hono";

import type { Env } from "../../env";
import { tenantQuery } from "../../lib/tenantClient";
import { tenantAuth, type TenantVars } from "../../middleware/tenant";
import { alHub } from "../../lib/enElHub";

import * as cmd from "./notificaciones.commands";
import * as q from "./notificaciones.queries";
import * as S from "./notificaciones.schemas";
import { badRequest } from "../../server/utils/response";
import { cuerpo } from "../../lib/validacion";
import { apply, decidirPorEstado, parseId } from "../../lib/rutas";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const notificacionesRoutes = new Hono<Ctx>();

notificacionesRoutes.use("*", tenantAuth, alHub);

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

// AUD-26: la papelera y marcar leída dicen en nombre de quién (el usuario de la sesión de la Handy,
// que pone Rust) y sólo actúan sobre una notificación dirigida a él y en el estado que toca: la
// condición va dentro de la sentencia (`DIRIGIDA_AL_USUARIO`), como en la Main. Si no toca ninguna
// fila, 404. Que el usuario sea de verdad el de la sesión no lo puede saber el worker (SEC-SESION).
// Cuando no se sabe cuántas filas tocó (`null`: un reintento cuyo recuento no se guardó), se mira cómo ha
// quedado la notificación (`decidirPorEstado`, en `lib/rutas.ts`), con la misma condición de destino.
const noEstaEnTuLista = (c: any) => c.json({ error: "notificacion_no_encontrada" }, 404);

notificacionesRoutes.post("/:id/descartar", cuerpo(S.papeleraSchema), async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_notificacion_invalido");
	const datos = c.req.valid("json");
	const hecho = await decidirPorEstado(await apply(c, cmd.descartar(id, datos.id_usuario)), () =>
		tenantQuery(c, (db) => q.dirigidaYEn(db, id, datos.id_usuario, "descartada")),
	);
	if (!hecho) return noEstaEnTuLista(c);
	return c.json({ ok: true });
});

notificacionesRoutes.post("/:id/restaurar", cuerpo(S.papeleraSchema), async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_notificacion_invalido");
	const datos = c.req.valid("json");
	const hecho = await decidirPorEstado(await apply(c, cmd.restaurar(id, datos.id_usuario)), () =>
		tenantQuery(c, (db) => q.dirigidaYEn(db, id, datos.id_usuario, "activa")),
	);
	if (!hecho) return noEstaEnTuLista(c);
	return c.json({ ok: true });
});

notificacionesRoutes.post("/:id/eliminar", cuerpo(S.papeleraSchema), async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_notificacion_invalido");
	const datos = c.req.valid("json");
	// Borrar es idempotente: si ya no está, está hecho. Si sigue ahí, no se borró, fuera suya o no.
	const hecho = await decidirPorEstado(await apply(c, cmd.eliminar(id, datos.id_usuario)), async () =>
		!(await tenantQuery(c, (db) => q.existe(db, id))),
	);
	if (!hecho) return noEstaEnTuLista(c);
	return c.json({ ok: true });
});

notificacionesRoutes.post("/:id/leer", cuerpo(S.marcarLeidaSchema), async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_notificacion_invalido");
	const datos = c.req.valid("json");
	// Ya leída, el INSERT no toca ninguna fila y no es un error: se mira antes si es suya. La
	// sentencia lleva la misma condición, que es la que vale al aplicarse.
	if (!(await tenantQuery(c, (db) => q.dirigidaA(db, id, datos.id_usuario)))) return noEstaEnTuLista(c);
	await apply(c, cmd.marcarLeida(id, datos.id_usuario));
	return c.json({ ok: true });
});
