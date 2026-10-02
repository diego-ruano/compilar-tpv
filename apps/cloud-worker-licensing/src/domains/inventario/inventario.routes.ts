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
import { redondearCantidad } from "../../lib/cantidad";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const inventarioRoutes = new Hono<Ctx>();

inventarioRoutes.use("*", tenantAuth);

// ───────────────── helpers ─────────────────

/** RI-55: lo visto sigue siendo lo que hay (con la tolerancia de `stock_sin_cambios` de Rust). */
function sigueComoSeVio(visto: number | null, actual: number | null): boolean {
	if (visto == null || actual == null) return visto == null && actual == null;
	return Math.abs(visto - actual) < 0.0005;
}

/** Una cantidad para un mensaje: sin ceros de más y con coma decimal («7», «0,5»). */
function cantidadTexto(x: number): string {
	return String(redondearCantidad(x)).replace(".", ",");
}

/** El ajuste llega tarde: lo que se vio ya no es lo que hay (RI-55). */
function stockCambiado(c: any, actual: number | null) {
	const ahora = actual == null ? "ahora no lleva stock suelto" : `ahora hay ${cantidadTexto(actual)}`;
	return c.json(
		{
			ok: false,
			error: "stock_cambiado",
			message: `Las existencias han cambiado mientras las ajustabas (${ahora}). Revísalas y vuelve a ajustar.`,
		},
		409,
	);
}

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
	// RI-55: el stock suelto sólo cuenta al crear; por eso hay que saber si existe.
	const esNuevo =
		!datos.id_producto ||
		(await tenantQuery(c, (db) => q.getProductoStockSuelto(db, datos.id_producto!))) === undefined;
	const id = await apply(c, cmd.upsertProducto(datos, esNuevo));
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
	const info = await tenantQuery(c, (db) => q.getLoteStock(db, id));
	if (!info) return c.json({ error: "Lote no encontrado" }, 404);
	// RI-55: sólo los datos del lote; las existencias van por el ajuste (PATCH).
	await apply(c, cmd.updateLote(id, { ...datos, id_lote: id }));
	return c.json({ ok: true });
});

inventarioRoutes.patch("/lotes/:id", cuerpo(S.ajusteLoteSchema), async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_lote inválido");
	const datos = c.req.valid("json");
	const info = await tenantQuery(c, (db) => q.getLoteStock(db, id));
	if (!info) return c.json({ error: "Lote no encontrado" }, 404);
	// RI-55: si lo que se vio ya no es lo que hay, alguien vendió o ajustó entre medias.
	const actual = redondearCantidad(info.stock_disponible);
	if (!sigueComoSeVio(datos.stock_visto, actual)) return stockCambiado(c, actual);
	if (sigueComoSeVio(datos.stock_nuevo, actual)) return c.json({ ok: true });
	// Y la misma condición va dentro del comando, por si se cuela algo entre esta lectura y el DO.
	const ajustado = await apply(c, cmd.ajustarLote(id, datos));
	if (Number(ajustado ?? 0) === 0) {
		const ahora = await tenantQuery(c, (db) => q.getLoteStock(db, id));
		return stockCambiado(c, ahora ? redondearCantidad(ahora.stock_disponible) : null);
	}
	return c.json({ ok: true });
});

// RI-55: el stock suelto de un producto se ajusta aquí, con su movimiento, y no al guardar la ficha.
inventarioRoutes.patch(
	"/productos/:id/stock-suelto",
	cuerpo(S.ajusteStockSueltoSchema),
	async (c) => {
		const id = parseId(c.req.param("id"));
		if (id == null) return badRequest(c, "id_producto inválido");
		const datos = c.req.valid("json");
		const leido = await tenantQuery(c, (db) => q.getProductoStockSuelto(db, id));
		if (leido === undefined) return c.json({ error: "Producto no encontrado" }, 404);
		const actual = leido == null ? null : redondearCantidad(leido);
		if (!sigueComoSeVio(datos.stock_visto ?? null, actual)) return stockCambiado(c, actual);
		if (sigueComoSeVio(datos.stock_nuevo ?? null, actual)) return c.json({ ok: true });
		const ajustado = await apply(c, cmd.ajustarStockSuelto(id, datos));
		if (Number(ajustado ?? 0) === 0) {
			const ahora = await tenantQuery(c, (db) => q.getProductoStockSuelto(db, id));
			return stockCambiado(c, ahora == null ? null : redondearCantidad(ahora));
		}
		return c.json({ ok: true });
	},
);
