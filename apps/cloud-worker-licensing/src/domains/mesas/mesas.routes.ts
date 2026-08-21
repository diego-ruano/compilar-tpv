// src/domains/mesas/mesas.routes.ts

import { Hono } from "hono";
import { z } from "zod";

import type { Env } from "../../env";
import { applyViaHub, HubError, type ApplyCommand } from "../../lib/hub";
import { tenantQuery } from "../../lib/tenantClient";
import { soloLaMainCobra, tenantAuth, type TenantVars } from "../../middleware/tenant";

import * as cmd from "./mesas.commands";
import * as q from "./mesas.queries";
import * as S from "./mesas.schemas";
import { badRequest } from "../../server/utils/response";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const mesasRoutes = new Hono<Ctx>();

mesasRoutes.use("*", tenantAuth);

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

mesasRoutes.get("/layout", async (c) =>
	c.json(await tenantQuery(c.env, c.get("tenantId"), (db) => q.loadLayout(db))),
);

mesasRoutes.post("/layout", async (c) => {
	const p = await parseBody(c, S.saveLayoutSchema);
	if (!p.ok) return p.res;
	await apply(c, cmd.saveLayout(p.data));
	return c.json({ ok: true });
});

mesasRoutes.get("/ocupadas", async (c) =>
	c.json(await tenantQuery(c.env, c.get("tenantId"), (db) => q.mesasOcupadas(db))),
);

mesasRoutes.get("/meta", async (c) =>
	c.json(await tenantQuery(c.env, c.get("tenantId"), (db) => q.mesasMetaAll(db))),
);

mesasRoutes.put("/reservas/:id/estado", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_reserva invalido");
	const p = await parseBody(c, S.setReservaEstadoSchema.omit({ id_reserva: true }));
	if (!p.ok) return p.res;
	await apply(c, cmd.setReservaEstado(id, p.data.estado));
	return c.json({ ok: true });
});

mesasRoutes.get("/comandas/mesa/:idMesa/abierta", async (c) => {
	const idMesa = parseId(c.req.param("idMesa"));
	if (idMesa == null) return badRequest(c, "id_mesa invalido");
	return c.json(
		await tenantQuery(c.env, c.get("tenantId"), (db) =>
			q.comandaAbiertaByMesa(db, idMesa),
		),
	);
});

mesasRoutes.post("/comandas", async (c) => {
	const p = await parseBody(c, S.abrirComandaSchema);
	if (!p.ok) return p.res;
	const resolved = await tenantQuery(c.env, c.get("tenantId"), async (db) => {
		const idTrabajador = await q.resolveTrabajadorId(
			db,
			p.data.id_trabajador_o_usuario,
		);
		// MESA-10: sin autoenlace de reserva; si no viene explicita, ID_Reserva queda null.
		return { idTrabajador, idReserva: p.data.id_reserva ?? null };
	});
	const row = await apply(
		c,
		cmd.abrirComanda(p.data, resolved.idTrabajador, resolved.idReserva),
	);
	return c.json(row);
});

mesasRoutes.put("/comandas/trabajador-if-null", async (c) => {
	const p = await parseBody(c, S.setTrabajadorSchema);
	if (!p.ok) return p.res;
	const idTrabajador = await tenantQuery(c.env, c.get("tenantId"), (db) =>
		q.resolveTrabajadorId(db, p.data.id_trabajador_o_usuario),
	);
	if (!idTrabajador) return c.json(false);
	await apply(c, cmd.setTrabajadorIfNull(p.data, idTrabajador));
	return c.json(true);
});

mesasRoutes.put("/comandas/cerrar", async (c) => {
	const p = await parseBody(c, S.cerrarComandaSchema);
	if (!p.ok) return p.res;
	await apply(c, cmd.cerrarComanda(p.data.id_comanda, p.data.total));
	return c.json({ ok: true });
});

mesasRoutes.get("/comandas/:id/lineas", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_comanda invalido");
	return c.json(await tenantQuery(c.env, c.get("tenantId"), (db) => q.lineas(db, id)));
});

mesasRoutes.post("/lineas", async (c) => {
	const p = await parseBody(c, S.addLineaSchema);
	if (!p.ok) return p.res;
	// MESA-07: resolvemos Estado_Cocina como literal para que el statement replicado a
	// la Main sea determinista (no una subquery de catalogo dentro del INSERT). El tipo de
	// IVA del producto viaja igual, y en la misma lectura.
	const datos = await tenantQuery(c.env, c.get("tenantId"), (db) =>
		q.datosDeLinea(db, p.data.id_producto),
	);
	await apply(
		c,
		cmd.addLinea(p.data, datos.pasaCocina ? "PENDIENTE" : null, datos.ivaPercent),
	);
	const lineas = await tenantQuery(c.env, c.get("tenantId"), (db) =>
		q.lineas(db, p.data.id_comanda),
	);
	return c.json({ ok: true, lineas });
});

mesasRoutes.post("/lineas/remove-one-pending", async (c) => {
	const p = await parseBody(c, S.removeOneDetalleSchema);
	if (!p.ok) return p.res;
	await apply(c, cmd.removeOnePendingDetalle(p.data.id_comanda, p.data.id_producto));
	return c.json({ ok: true });
});

mesasRoutes.delete("/lineas/:id", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_detalle invalido");
	const idComanda = await tenantQuery(c.env, c.get("tenantId"), (db) =>
		q.idComandaByDetalle(db, id),
	);
	await apply(c, cmd.deleteDetalle(id, idComanda));
	return c.json({ ok: true });
});

mesasRoutes.put("/lineas/:id/nota", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_detalle invalido");
	const p = await parseBody(
		c,
		z.object({ nota: z.any().optional().nullable() }).transform((v) => {
			const s = String(v.nota ?? "").trim();
			return { nota: s ? s : null };
		}),
	);
	if (!p.ok) return p.res;
	await apply(c, cmd.updateDetalleNota(id, p.data.nota));
	return c.json({ ok: true });
});

mesasRoutes.post("/cobrar-detalles", async (c) => {
	const veto = await soloLaMainCobra(c);
	if (veto) return veto;
	const p = await parseBody(c, S.cobrarDetallesSchema);
	if (!p.ok) return p.res;
	const plan = await tenantQuery(c.env, c.get("tenantId"), (db) =>
		q.cobrarDetallesPlan(db, p.data),
	);
	if (!plan.ok) throw new HubError(plan.error, 409);
	await apply(c, cmd.cobrarDetalles(p.data, plan));
	return c.json({ ok: true });
});

mesasRoutes.get("/categorias", async (c) =>
	c.json(await tenantQuery(c.env, c.get("tenantId"), (db) => q.categorias(db))),
);

mesasRoutes.get("/productos/search", async (c) => {
	const parsed = S.searchSchema.safeParse({
		query: c.req.query("query"),
		q: c.req.query("q"),
		texto: c.req.query("texto"),
	});
	if (!parsed.success) return badRequest(c, "validation_error", parsed.error);
	return c.json(
		await tenantQuery(c.env, c.get("tenantId"), (db) =>
			q.searchProductos(db, parsed.data.query),
		),
	);
});

mesasRoutes.get("/productos/:idCategoria", async (c) => {
	const id = parseId(c.req.param("idCategoria"));
	if (id == null) return badRequest(c, "id_categoria invalido");
	return c.json(
		await tenantQuery(c.env, c.get("tenantId"), (db) =>
			q.productosByCategoria(db, id),
		),
	);
});

mesasRoutes.get("/kitchen/today-pending", async (c) =>
	c.json(await tenantQuery(c.env, c.get("tenantId"), (db) => q.kitchenList(db))),
);

mesasRoutes.put("/kitchen/line-state", async (c) => {
	const p = await parseBody(c, S.kitchenStateSchema);
	if (!p.ok) return p.res;
	await apply(
		c,
		cmd.kitchenSetLineState(
			p.data.id_detalle,
			p.data.id_usuario_cocinero,
			p.data.estado,
		),
	);
	return c.json({ ok: true });
});
