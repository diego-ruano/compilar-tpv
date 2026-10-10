// src/domains/venta_rapida/venta_rapida.routes.ts

import { Hono } from "hono";
import * as z from "zod";

import type { Env } from "../../env";
import { HubError } from "../../lib/hub";
import { tenantQuery } from "../../lib/tenantClient";
import { soloLaMainCobra, tenantAuth, type TenantVars } from "../../middleware/tenant";

import * as cmd from "./venta_rapida.commands";
import * as q from "./venta_rapida.queries";
// El tipo de IVA de un producto es la misma lectura para barra y para mesa: vive en las queries de
// mesas y se reutiliza en vez de duplicarla.
import * as mesasQ from "../mesas/mesas.queries";
import * as S from "./venta_rapida.schemas";
import { badRequest } from "../../server/utils/response";
import { consulta, cuerpo } from "../../lib/validacion";
import { apply, parseId } from "../../lib/rutas";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const ventaRapidaRoutes = new Hono<Ctx>();

ventaRapidaRoutes.use("*", tenantAuth);

function conflictStock(plan: any): never {
	throw new HubError(
		plan?.error === "insufficient_stock"
			? `insufficient_stock:${plan.productoId}:${plan.requested}:${plan.available}`
			: String(plan?.error || "conflict"),
		409,
	);
}

ventaRapidaRoutes.get("/categorias", async (c) =>
	c.json(await tenantQuery(c, (db) => q.categorias(db))),
);

ventaRapidaRoutes.get("/productos/search", consulta(S.searchProductosSchema), async (c) => {
	const { query, limit } = c.req.valid("query");
	return c.json(
		await tenantQuery(c, (db) => q.searchProductos(db, query, limit)),
	);
});

ventaRapidaRoutes.get("/productos/:idCategoria", async (c) => {
	const id = parseId(c.req.param("idCategoria"));
	if (id == null) return badRequest(c, "id_categoria invalido");
	return c.json(
		await tenantQuery(c, (db) =>
			q.productosByCategoria(db, id),
		),
	);
});

ventaRapidaRoutes.get("/comandas", consulta(S.listComandasSchema), async (c) => {
	const { include_pagadas, limit } = c.req.valid("query");
	return c.json(
		await tenantQuery(c, (db) => q.listComandas(db, include_pagadas, limit)),
	);
});

ventaRapidaRoutes.get("/comandas/:id/lineas", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_comanda invalido");
	return c.json(await tenantQuery(c, (db) => q.lineas(db, id)));
});

ventaRapidaRoutes.get("/comandas/:id/ticket-detalles", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_comanda invalido");
	return c.json(
		await tenantQuery(c, (db) =>
			q.detallesVerTicket(db, id),
		),
	);
});

ventaRapidaRoutes.post("/index-rows", cuerpo(S.idsSchema), async (c) => {
	const datos = c.req.valid("json");
	return c.json(
		await tenantQuery(c, (db) =>
			q.indexRows(db, datos.ids),
		),
	);
});

ventaRapidaRoutes.post("/comandas/barra", cuerpo(S.createComandaBarraSchema), async (c) => {
	const datos = c.req.valid("json");

	if (datos.get_or_create) {
		const existing = await tenantQuery(c, (db) =>
			q.openBarraComanda(db),
		);
		if (existing) return c.json({ ok: true, id_comanda: existing });
	}

	const idTrab = await tenantQuery(c, (db) =>
		q.resolveTrabajadorId(db, datos.id_trabajador),
	);
	const id = await apply(c, cmd.createComandaBarra(datos, idTrab));
	return c.json({ ok: true, id_comanda: id });
});

ventaRapidaRoutes.post("/lineas", cuerpo(S.addLineaSchema), async (c) => {
	const entrada = c.req.valid("json");
	// El tipo de IVA y el precio se resuelven aquí y viajan como literales: dentro del INSERT
	// serían una subconsulta que la Main reevaluaría en otro estado. El precio vuelve en la
	// respuesta para que la pantalla enseñe el que se cobrará y no el de su carta en caché (RI-27).
	const datos = await tenantQuery(c, (db) =>
		mesasQ.datosDeLinea(db, entrada.id_producto),
	);
	if (datos.archivado) return c.json({ ok: false, error: "producto_archivado" }, 409);
	const id = await apply(c, cmd.addLinea(entrada, datos.ivaPercent, datos.nombre, datos.precio));
	return c.json({ ok: true, id_detalle: id, precio_unitario: datos.precio });
});

ventaRapidaRoutes.post("/lineas/remove-last-unpaid", cuerpo(S.removeLastLineaSchema), async (c) => {
	const datos = c.req.valid("json");
	await apply(c, cmd.removeLastUnpaidLinea(datos));
	return c.json({ ok: true });
});

ventaRapidaRoutes.post("/lineas/delete-if-unpaid", cuerpo(S.deleteLineaSchema), async (c) => {
	const datos = c.req.valid("json");
	await apply(c, cmd.deleteLineaIfUnpaid(datos));
	return c.json({ ok: true });
});

ventaRapidaRoutes.put("/lineas/nota", cuerpo(S.updateNotaSchema), async (c) => {
	const datos = c.req.valid("json");
	await apply(c, cmd.updateNotaDetalle(datos));
	return c.json({ ok: true });
});

ventaRapidaRoutes.post("/cobrar-fraccionado", soloLaMainCobra, cuerpo(S.cobrarFraccionadoSchema), async (c) => {
	const datos = c.req.valid("json");
	const plan = await tenantQuery(c, (db) =>
		q.cobrarPlan(db, datos),
	);
	if (!plan.ok) conflictStock(plan);
	await apply(c, cmd.cobrarFraccionado(datos, plan));
	return c.json({ ok: true, id_pago: plan.id_pago });
});

ventaRapidaRoutes.post("/comandas/delete-if-safe", cuerpo(z.object({ id_comanda: z.coerce.string().trim().min(1) })), async (c) => {
	const datos = c.req.valid("json");
	const hasPaid = await tenantQuery(c, (db) =>
		q.hasPaidLines(db, datos.id_comanda),
	);
	if (hasPaid) throw new HubError("comanda_has_paid_lines", 409);
	await apply(c, cmd.deleteComandaIfSafe(datos.id_comanda));
	return c.json({ ok: true });
});
