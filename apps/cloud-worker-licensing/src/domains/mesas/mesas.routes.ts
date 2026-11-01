// src/domains/mesas/mesas.routes.ts

import { Hono } from "hono";
import * as z from "zod";

import type { Env } from "../../env";
import { HubError } from "../../lib/hub";
import { recortar } from "../../lib/texto";
import { parseClientNow } from "../../durableObjects/tenantHub.tiempo";
import { tenantQuery } from "../../lib/tenantClient";
import { soloLaMainCobra, tenantAuth, type TenantVars } from "../../middleware/tenant";

import * as cmd from "./mesas.commands";
import * as q from "./mesas.queries";
import * as S from "./mesas.schemas";
import { estadoYOrigen } from "../reservas/reservas.queries";
import { cambioDesdeLaMesa } from "./estadoDesdeLaMesa";
import { badRequest } from "../../server/utils/response";
import { consulta, cuerpo } from "../../lib/validacion";
import { apply, parseId } from "../../lib/rutas";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const mesasRoutes = new Hono<Ctx>();

mesasRoutes.use("*", tenantAuth);

mesasRoutes.get("/layout", async (c) =>
	c.json(await tenantQuery(c, (db) => q.loadLayout(db))),
);

mesasRoutes.post("/layout", cuerpo(S.saveLayoutSchema), async (c) => {
	const datos = c.req.valid("json");
	await apply(c, cmd.saveLayout(datos));
	return c.json({ ok: true });
});

mesasRoutes.get("/meta", async (c) => {
	// MESAS-02: la hora local de la Handy, validada como la usa `tenantQuery`; sin ella, el reloj del worker.
	const ahoraLocal = parseClientNow(c.req.header("X-Client-Now"));
	return c.json(await tenantQuery(c, (db) => q.mesasMetaAll(db, ahoraLocal)));
});

mesasRoutes.put("/reservas/:id/estado", cuerpo(S.setReservaEstadoSchema.omit({ id_reserva: true })), async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_reserva_invalido");
	const datos = c.req.valid("json");
	// Con la reserva como está ahora, como la Main: la mesa abierta enseña una foto, y mientras tanto
	// el cliente pudo cancelarla o pasar a «No vino». Se replica la escritura sin condición.
	const actual = await tenantQuery(c, (db) => estadoYOrigen(db, id));
	const cambio = cambioDesdeLaMesa(actual?.estado ?? null, datos.estado);
	if (cambio === "cambiada") return c.json({ error: "reserva_cambiada" }, 409);
	if (cambio === "escribir") await apply(c, cmd.setReservaEstado(id, datos.estado));
	return c.json({ ok: true });
});

mesasRoutes.get("/comandas/mesa/:idMesa/abierta", async (c) => {
	const idMesa = parseId(c.req.param("idMesa"));
	if (idMesa == null) return badRequest(c, "id_mesa_invalido");
	return c.json(
		await tenantQuery(c, (db) =>
			q.comandaAbiertaByMesa(db, idMesa),
		),
	);
});

mesasRoutes.post("/comandas", cuerpo(S.abrirComandaSchema), async (c) => {
	const datos = c.req.valid("json");
	const resolved = await tenantQuery(c, async (db) => {
		const idTrabajador = await q.resolveTrabajadorId(
			db,
			datos.id_trabajador_o_usuario,
		);
		// MESA-10: sin autoenlace de reserva; si no viene explicita, ID_Reserva queda null.
		return { idTrabajador, idReserva: datos.id_reserva ?? null };
	});
	const row = await apply(
		c,
		cmd.abrirComanda(datos, resolved.idTrabajador, resolved.idReserva),
	);
	return c.json(row);
});

mesasRoutes.put("/comandas/trabajador-if-null", cuerpo(S.setTrabajadorSchema), async (c) => {
	const datos = c.req.valid("json");
	const idTrabajador = await tenantQuery(c, (db) =>
		q.resolveTrabajadorId(db, datos.id_trabajador_o_usuario),
	);
	if (!idTrabajador) return c.json(false);
	await apply(c, cmd.setTrabajadorIfNull(datos, idTrabajador));
	return c.json(true);
});

// INC-20261030-007: la reserva que llega pasa a la comanda que ya estaba abierta en su mesa.
mesasRoutes.put("/comandas/reserva-if-null", cuerpo(S.setReservaSchema), async (c) => {
	await apply(c, cmd.setReservaIfNull(c.req.valid("json")));
	return c.json(true);
});

mesasRoutes.get("/comandas/:id/lineas", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_comanda_invalido");
	return c.json(await tenantQuery(c, (db) => q.lineas(db, id)));
});

mesasRoutes.post("/lineas", cuerpo(S.addLineaSchema), async (c) => {
	const entrada = c.req.valid("json");
	// MESA-07: resolvemos Estado_Cocina como literal para que el statement replicado a
	// la Main sea determinista (no una subquery de catalogo dentro del INSERT). El tipo de
	// IVA y el precio del producto viajan igual, y en la misma lectura (RI-27).
	const datos = await tenantQuery(c, (db) =>
		q.datosDeLinea(db, entrada.id_producto),
	);
	if (datos.archivado) return c.json({ ok: false, error: "producto_archivado" }, 409);
	if (await tenantQuery(c, (db) => q.comandaCobrada(db, entrada.id_comanda))) {
		return c.json({ ok: false, error: "comanda_cobrada" }, 409);
	}
	await apply(
		c,
		cmd.addLinea(
			entrada,
			datos.pasaCocina ? "PENDIENTE" : null,
			datos.ivaPercent,
			datos.nombre,
			datos.precio,
		),
	);
	const lineas = await tenantQuery(c, (db) =>
		q.lineas(db, entrada.id_comanda),
	);
	return c.json({ ok: true, lineas });
});

mesasRoutes.post("/lineas/remove-one-pending", cuerpo(S.removeOneDetalleSchema), async (c) => {
	const datos = c.req.valid("json");
	await apply(c, cmd.removeOnePendingDetalle(datos.id_comanda, datos.id_producto));
	return c.json({ ok: true });
});

mesasRoutes.delete("/lineas/:id", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_detalle_invalido");
	const idComanda = await tenantQuery(c, (db) =>
		q.idComandaByDetalle(db, id),
	);
	await apply(c, cmd.deleteDetalle(id, idComanda));
	return c.json({ ok: true });
});

mesasRoutes.put(
	"/lineas/:id/nota",
	cuerpo(
		z.object({ nota: z.any().optional().nullable() }).transform((v) => {
			const s = recortar(String(v.nota ?? ""));
			return { nota: s ? s : null };
		}),
	),
	async (c) => {
		const id = parseId(c.req.param("id"));
		if (id == null) return badRequest(c, "id_detalle_invalido");
		await apply(c, cmd.updateDetalleNota(id, c.req.valid("json").nota));
		return c.json({ ok: true });
	},
);

mesasRoutes.post("/cobrar-detalles", soloLaMainCobra, cuerpo(S.cobrarDetallesSchema), async (c) => {
	const datos = c.req.valid("json");
	const plan = await tenantQuery(c, (db) =>
		q.cobrarDetallesPlan(db, datos),
	);
	if (!plan.ok) throw new HubError(plan.error, 409);
	await apply(c, cmd.cobrarDetalles(datos, plan));
	return c.json({ ok: true });
});

mesasRoutes.get("/categorias", async (c) =>
	c.json(await tenantQuery(c, (db) => q.categorias(db))),
);

mesasRoutes.get("/productos/search", consulta(S.searchSchema), async (c) => {
	return c.json(
		await tenantQuery(c, (db) =>
			q.searchProductos(db, c.req.valid("query").query),
		),
	);
});

mesasRoutes.get("/productos/:idCategoria", async (c) => {
	const id = parseId(c.req.param("idCategoria"));
	if (id == null) return badRequest(c, "id_categoria_invalido");
	return c.json(
		await tenantQuery(c, (db) =>
			q.productosByCategoria(db, id),
		),
	);
});

mesasRoutes.get("/kitchen/today-pending", async (c) =>
	c.json(await tenantQuery(c, (db) => q.kitchenList(db))),
);

mesasRoutes.put("/kitchen/line-state", cuerpo(S.kitchenStateSchema), async (c) => {
	const datos = c.req.valid("json");
	await apply(
		c,
		cmd.kitchenSetLineState(
			datos.id_detalle,
			datos.id_usuario_cocinero,
			datos.estado,
		),
	);
	return c.json({ ok: true });
});
