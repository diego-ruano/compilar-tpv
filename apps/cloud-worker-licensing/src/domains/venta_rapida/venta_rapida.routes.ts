// src/domains/venta_rapida/venta_rapida.routes.ts

import { Hono } from "hono";
import { z } from "zod";

import type { Env } from "../../env";
import { applyViaHub, HubError, type ApplyCommand } from "../../lib/hub";
import { tenantQuery } from "../../lib/tenantClient";
import { tenantAuth, type TenantVars } from "../../middleware/tenant";

import * as cmd from "./venta_rapida.commands";
import * as q from "./venta_rapida.queries";
import * as S from "./venta_rapida.schemas";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const ventaRapidaRoutes = new Hono<Ctx>();

ventaRapidaRoutes.use("*", tenantAuth);

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

function conflictStock(plan: any): never {
	throw new HubError(
		plan?.error === "insufficient_stock"
			? `insufficient_stock:${plan.productoId}:${plan.requested}:${plan.available}`
			: String(plan?.error || "conflict"),
		409,
	);
}

ventaRapidaRoutes.get("/categorias", async (c) =>
	c.json(await tenantQuery(c.env, c.get("tenantId"), (db) => q.categorias(db))),
);

ventaRapidaRoutes.get("/productos/search", async (c) => {
	const parsed = S.searchProductosSchema.safeParse({
		query: c.req.query("query") ?? c.req.query("q") ?? "",
		limit: c.req.query("limit"),
	});
	if (!parsed.success) return badRequest(c, "validation_error", parsed.error);
	return c.json(
		await tenantQuery(c.env, c.get("tenantId"), (db) =>
			q.searchProductos(db, parsed.data.query, parsed.data.limit),
		),
	);
});

ventaRapidaRoutes.get("/productos/:idCategoria", async (c) => {
	const id = parseId(c.req.param("idCategoria"));
	if (id == null) return badRequest(c, "id_categoria invalido");
	return c.json(
		await tenantQuery(c.env, c.get("tenantId"), (db) =>
			q.productosByCategoria(db, id),
		),
	);
});

ventaRapidaRoutes.get("/comandas", async (c) => {
	const parsed = S.listComandasSchema.safeParse({
		include_pagadas: c.req.query("include_pagadas") ?? false,
		limit: c.req.query("limit"),
	});
	if (!parsed.success) return badRequest(c, "validation_error", parsed.error);
	return c.json(
		await tenantQuery(c.env, c.get("tenantId"), (db) =>
			q.listComandas(
				db,
				parsed.data.include_pagadas,
				parsed.data.limit,
			),
		),
	);
});

ventaRapidaRoutes.get("/comandas/:id/lineas", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_comanda invalido");
	return c.json(await tenantQuery(c.env, c.get("tenantId"), (db) => q.lineas(db, id)));
});

ventaRapidaRoutes.get("/comandas/:id/ticket-detalles", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_comanda invalido");
	return c.json(
		await tenantQuery(c.env, c.get("tenantId"), (db) =>
			q.detallesVerTicket(db, id),
		),
	);
});

ventaRapidaRoutes.post("/index-rows", async (c) => {
	const p = await parseBody(c, S.idsSchema);
	if (!p.ok) return p.res;
	return c.json(
		await tenantQuery(c.env, c.get("tenantId"), (db) =>
			q.indexRows(db, p.data.ids),
		),
	);
});

ventaRapidaRoutes.post("/comandas/barra", async (c) => {
	const p = await parseBody(c, S.createComandaBarraSchema);
	if (!p.ok) return p.res;

	if (p.data.get_or_create) {
		const existing = await tenantQuery(c.env, c.get("tenantId"), (db) =>
			q.openBarraComanda(db),
		);
		if (existing) return c.json({ ok: true, id_comanda: existing });
	}

	const idTrab = await tenantQuery(c.env, c.get("tenantId"), (db) =>
		q.resolveTrabajadorId(db, p.data.id_trabajador),
	);
	const id = await apply(c, cmd.createComandaBarra(p.data, idTrab));
	return c.json({ ok: true, id_comanda: id });
});

ventaRapidaRoutes.post("/lineas", async (c) => {
	const p = await parseBody(c, S.addLineaSchema);
	if (!p.ok) return p.res;
	const id = await apply(c, cmd.addLinea(p.data));
	return c.json({ ok: true, id_detalle: id });
});

ventaRapidaRoutes.post("/lineas/remove-last-unpaid", async (c) => {
	const p = await parseBody(c, S.removeLastLineaSchema);
	if (!p.ok) return p.res;
	await apply(c, cmd.removeLastUnpaidLinea(p.data));
	return c.json({ ok: true });
});

ventaRapidaRoutes.post("/lineas/delete-if-unpaid", async (c) => {
	const p = await parseBody(c, S.deleteLineaSchema);
	if (!p.ok) return p.res;
	await apply(c, cmd.deleteLineaIfUnpaid(p.data));
	return c.json({ ok: true });
});

ventaRapidaRoutes.put("/lineas/nota", async (c) => {
	const p = await parseBody(c, S.updateNotaSchema);
	if (!p.ok) return p.res;
	await apply(c, cmd.updateNotaDetalle(p.data));
	return c.json({ ok: true });
});

ventaRapidaRoutes.post("/cobrar-fraccionado", async (c) => {
	const p = await parseBody(c, S.cobrarFraccionadoSchema);
	if (!p.ok) return p.res;
	const plan = await tenantQuery(c.env, c.get("tenantId"), (db) =>
		q.cobrarPlan(db, p.data),
	);
	if (!plan.ok) conflictStock(plan);
	await apply(c, cmd.cobrarFraccionado(p.data, plan));
	return c.json({ ok: true, id_pago: plan.id_pago });
});

ventaRapidaRoutes.post("/restar-stock", async (c) => {
	const p = await parseBody(c, S.restarStockSchema);
	if (!p.ok) return p.res;
	if (!p.data.lineas.length) return c.json({ ok: true });
	const plan = await tenantQuery(c.env, c.get("tenantId"), (db) =>
		q.restarStockPlan(db, p.data),
	);
	if (!plan.ok) conflictStock(plan);
	await apply(c, cmd.restarStock(p.data, plan));
	return c.json({ ok: true });
});

ventaRapidaRoutes.post("/comandas/delete-if-safe", async (c) => {
	const p = await parseBody(c, z.object({ id_comanda: z.coerce.string().trim().min(1) }));
	if (!p.ok) return p.res;
	const hasPaid = await tenantQuery(c.env, c.get("tenantId"), (db) =>
		q.hasPaidLines(db, p.data.id_comanda),
	);
	if (hasPaid) throw new HubError("comanda_has_paid_lines", 409);
	await apply(c, cmd.deleteComandaIfSafe(p.data.id_comanda));
	return c.json({ ok: true });
});
