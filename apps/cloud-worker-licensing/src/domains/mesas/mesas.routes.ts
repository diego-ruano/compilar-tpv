// src/domains/mesas/mesas.routes.ts

import { Hono } from "hono";
import * as z from "zod";

import type { Env } from "../../env";
import { HubError } from "../../lib/hub";
import { recortar } from "../../lib/texto";
import { parseClientNow } from "../../durableObjects/tenantHub.tiempo";
import { tenantQuery } from "../../lib/tenantClient";
import { soloLaMainCobra, tenantAuth, type TenantVars } from "../../middleware/tenant";
import { alHub } from "../../lib/enElHub";

import { planAbrirORetomar } from "./abrirORetomar";
import * as cmd from "./mesas.commands";
import * as q from "./mesas.queries";
import * as S from "./mesas.schemas";
import { estadoYOrigen } from "../reservas/reservas.queries";
import { cambioDesdeLaMesa } from "./estadoDesdeLaMesa";
import { badRequest } from "../../server/utils/response";
import { cuerpo } from "../../lib/validacion";
import { apply, lecturaPorPost, parseId } from "../../lib/rutas";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const mesasRoutes = new Hono<Ctx>();

// AUD-27: lectura por POST (lo que se escribe en el buscador va en el cuerpo, no en la URL).
mesasRoutes.use("/productos/search", lecturaPorPost());
mesasRoutes.use("*", tenantAuth, alHub);

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
	// el cliente pudo cancelarla o pasar a «No vino». Se replica la escritura sin condición; que la
	// reserva siga como se leyó lo mira la guarda del comando, dentro del lote (SYNC-30).
	const actual = await tenantQuery(c, (db) => estadoYOrigen(db, id));
	const cambio = cambioDesdeLaMesa(actual?.estado ?? null, datos.estado);
	if (cambio === "cambiada") return c.json({ error: "reserva_cambiada" }, 409);
	if (cambio === "escribir" && actual) await apply(c, cmd.setReservaEstado(id, datos.estado, actual.estado));
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

// Abrir o retomar la mesa en un viaje: la comanda abierta (creada si no hay ninguna, con el
// trabajador si le faltaba) y sus líneas. Espejo de `abrir_o_retomar_comanda` en la Main.
mesasRoutes.post("/comandas/abrir-o-retomar", cuerpo(S.abrirComandaSchema), async (c) => {
	const datos = c.req.valid("json");
	const comando = await tenantQuery(c, (db) => planAbrirORetomar(db, datos));
	if (comando) await apply(c, comando);
	return c.json(await tenantQuery(c, (db) => q.comandaConLineas(db, datos.id_mesa)));
});

mesasRoutes.put("/comandas/trabajador-if-null", cuerpo(S.setTrabajadorSchema), async (c) => {
	const datos = c.req.valid("json");
	const { idTrabajador, porPoner } = await tenantQuery(c, async (db) => ({
		idTrabajador: await q.resolveTrabajadorId(db, datos.id_trabajador_o_usuario),
		porPoner: await q.trabajadorPorPoner(db, datos.id_comanda),
	}));
	// Ya tiene trabajador (o líneas, o está cobrada): la sentencia no cambiaría nada y aun así se
	// replicaría, con su aviso a los demás equipos. No se escribe, como en la Main.
	if (!idTrabajador || !porPoner) return c.json(false);
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
	// IVA y el precio del producto viajan igual, y en la misma lectura (RI-27). Que el producto siga
	// en la carta y la comanda sin cobrar lo deciden las guardas del comando, dentro del lote
	// (SYNC-30): `producto_archivado` o `comanda_cobrada`.
	const datos = await tenantQuery(c, (db) =>
		q.datosDeLinea(db, entrada.id_producto),
	);
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

// Lo que se pide distinto en una línea (sin cebolla, extra de queso). No cambia el precio.
mesasRoutes.put("/lineas/:id/ingredientes", cuerpo(S.cambiosIngredientesSchema), async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_detalle_invalido");
	await apply(c, cmd.updateDetalleIngredientes(id, c.req.valid("json").cambios));
	return c.json({ ok: true });
});

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

mesasRoutes.post("/productos/search", cuerpo(S.searchSchema), async (c) => {
	const { query } = c.req.valid("json");
	return c.json(
		await tenantQuery(c, (db) =>
			q.searchProductos(db, query),
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
