// src/domains/inventario/inventario.routes.ts
//
// Subrouter Hono del módulo de inventario. Se monta en /v1/inventario (index.ts).
//
// - Auth de tenant en todas las rutas (JWT + device proof) vía `tenantAuth`.
// - LECTURAS (GET): directas a Turso con `tenantQuery`.
// - ESCRITURAS (POST/PUT/PATCH/DELETE): pasan por el DO (`applyViaHub`), que aplica
//   en transacción con idempotencia por Op_Id (cabecera X-Idempotency-Key) y hace
//   broadcast del cambio. Requieren que haya una Main conectada (si no, main_offline).

import { Hono } from "hono";

import type { Env } from "../../env";
import { tenantAuth, type TenantVars } from "../../middleware/tenant";
import { tenantQuery } from "../../lib/tenantClient";
import { applyViaHub } from "../../lib/hub";

import * as q from "./inventario.queries";
import * as cmd from "./inventario.commands";
import * as S from "./inventario.schemas";
import { badRequest } from "../../server/utils/response";
import { cuerpo } from "../../lib/validacion";
import { apply, parseId } from "../../lib/rutas";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const inventarioRoutes = new Hono<Ctx>();

inventarioRoutes.use("*", tenantAuth);

// ───────────────── helpers ─────────────────

// Aplica una escritura por el DO. Exige Op_Id (idempotencia).
// ───────────────── LECTURAS ─────────────────

inventarioRoutes.get("/categorias", async (c) =>
	c.json(await tenantQuery(c, (db) => q.listCategorias(db))),
);

inventarioRoutes.get("/proveedores-mini", async (c) =>
	c.json(await tenantQuery(c, (db) => q.listProveedoresMini(db))),
);

inventarioRoutes.get("/productos", async (c) => {
	const idCategoria = parseId(c.req.query("categoria"));
	if (idCategoria == null) return badRequest(c, "categoria inválida");
	return c.json(
		await tenantQuery(c, (db) =>
			q.listProductosByCategoria(db, idCategoria),
		),
	);
});

inventarioRoutes.get("/resumen", async (c) => {
	const limit = Number(c.req.query("limit")) || 12;
	return c.json(await tenantQuery(c, (db) => q.resumen(db, limit)));
});

inventarioRoutes.get("/alergenos", async (c) =>
	c.json(await tenantQuery(c, (db) => q.listAlergenos(db))),
);

inventarioRoutes.get("/productos/:id/alergenos", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_producto inválido");
	return c.json(
		await tenantQuery(c, (db) => q.alergenosProducto(db, id)),
	);
});

inventarioRoutes.get("/productos/:id/lotes", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_producto inválido");
	return c.json(
		await tenantQuery(c, (db) => q.listLotesByProducto(db, id)),
	);
});

inventarioRoutes.get("/productos/:id", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_producto inválido");
	return c.json(await tenantQuery(c, (db) => q.productDetail(db, id)));
});

// ───────────────── ESCRITURAS ─────────────────

inventarioRoutes.post("/categorias", cuerpo(S.upsertCategoriaSchema), async (c) => {
	const datos = c.req.valid("json");
	const id = await apply(c, cmd.createCategoria(datos));
	return c.json({ id_categoria: id });
});

inventarioRoutes.post("/productos", cuerpo(S.upsertProductoSchema), async (c) => {
	const datos = c.req.valid("json");
	const id = await apply(c, cmd.upsertProducto(datos));
	return c.json({ id_producto: id });
});

inventarioRoutes.delete("/productos/:id", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_producto inválido");
	// INV-05: no borrar productos con histórico de ventas; mensaje claro en vez de error crudo de FK.
	const enUso = await tenantQuery(c, (db) =>
		q.productoReferenciado(db, id),
	);
	if (enUso) {
		return c.json(
			{ error: "No se puede borrar: el producto tiene ventas registradas en comandas." },
			409,
		);
	}
	await apply(c, cmd.deleteProducto(id));
	return c.json({ ok: true });
});

inventarioRoutes.put("/productos/:id/alergenos", cuerpo(S.setAlergenosSchema), async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_producto inválido");
	const datos = c.req.valid("json");
	await apply(c, cmd.setAlergenosProducto(id, datos));
	return c.json({ ok: true });
});

inventarioRoutes.post("/lotes", cuerpo(S.createLoteSchema), async (c) => {
	const datos = c.req.valid("json");
	const id = await apply(c, cmd.createLote(datos));
	return c.json({ id_lote: id });
});

inventarioRoutes.put("/lotes/:id", cuerpo(S.updateLoteSchema), async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_lote inválido");
	const datos = c.req.valid("json");
	// El disponible previo es el delta del movimiento de auditoría (INV-01b).
	const info = await tenantQuery(c, (db) => q.getLoteStock(db, id));
	if (!info) return c.json({ error: "Lote no encontrado" }, 404);
	await apply(c, cmd.updateLote(id, { ...datos, id_lote: id }, info.stock_disponible));
	return c.json({ ok: true });
});

inventarioRoutes.patch("/lotes/:id", cuerpo(S.ajusteLoteSchema), async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_lote inválido");
	const datos = c.req.valid("json");
	// El disponible previo es el delta del movimiento de auditoría (INV-01b).
	const info = await tenantQuery(c, (db) => q.getLoteStock(db, id));
	if (!info) return c.json({ error: "Lote no encontrado" }, 404);
	await apply(c, cmd.ajustarLote(id, datos, info.stock_disponible));
	return c.json({ ok: true });
});
