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
import { z } from "zod";

import type { Env } from "../../env";
import { tenantAuth, type TenantVars } from "../../middleware/tenant";
import { tenantQuery } from "../../lib/tenantClient";
import { applyViaHub, HubError, type ApplyCommand } from "../../lib/hub";

import * as q from "./inventario.queries";
import * as cmd from "./inventario.commands";
import * as S from "./inventario.schemas";
import { badRequest } from "../../server/utils/response";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const inventarioRoutes = new Hono<Ctx>();

inventarioRoutes.use("*", tenantAuth);

// ───────────────── helpers ─────────────────

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

// Aplica una escritura por el DO. Exige Op_Id (idempotencia).
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

// ───────────────── LECTURAS ─────────────────

inventarioRoutes.get("/categorias", async (c) =>
	c.json(await tenantQuery(c.env, c.get("tenantId"), (db) => q.listCategorias(db))),
);

inventarioRoutes.get("/proveedores-mini", async (c) =>
	c.json(await tenantQuery(c.env, c.get("tenantId"), (db) => q.listProveedoresMini(db))),
);

inventarioRoutes.get("/productos", async (c) => {
	const idCategoria = parseId(c.req.query("categoria"));
	if (idCategoria == null) return badRequest(c, "categoria inválida");
	return c.json(
		await tenantQuery(c.env, c.get("tenantId"), (db) =>
			q.listProductosByCategoria(db, idCategoria),
		),
	);
});

inventarioRoutes.get("/resumen", async (c) => {
	const limit = Number(c.req.query("limit")) || 12;
	return c.json(await tenantQuery(c.env, c.get("tenantId"), (db) => q.resumen(db, limit)));
});

inventarioRoutes.get("/alergenos", async (c) =>
	c.json(await tenantQuery(c.env, c.get("tenantId"), (db) => q.listAlergenos(db))),
);

inventarioRoutes.get("/productos/:id/alergenos", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_producto inválido");
	return c.json(
		await tenantQuery(c.env, c.get("tenantId"), (db) => q.alergenosProducto(db, id)),
	);
});

inventarioRoutes.get("/productos/:id/lotes", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_producto inválido");
	return c.json(
		await tenantQuery(c.env, c.get("tenantId"), (db) => q.listLotesByProducto(db, id)),
	);
});

inventarioRoutes.get("/productos/:id", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_producto inválido");
	return c.json(await tenantQuery(c.env, c.get("tenantId"), (db) => q.productDetail(db, id)));
});

// ───────────────── ESCRITURAS ─────────────────

inventarioRoutes.post("/categorias", async (c) => {
	const p = await parseBody(c, S.upsertCategoriaSchema);
	if (!p.ok) return p.res;
	const id = await apply(c, cmd.createCategoria(p.data));
	return c.json({ id_categoria: id });
});

inventarioRoutes.post("/productos", async (c) => {
	const p = await parseBody(c, S.upsertProductoSchema);
	if (!p.ok) return p.res;
	const id = await apply(c, cmd.upsertProducto(p.data));
	return c.json({ id_producto: id });
});

inventarioRoutes.delete("/productos/:id", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_producto inválido");
	// INV-05: no borrar productos con histórico de ventas; mensaje claro en vez de error crudo de FK.
	const enUso = await tenantQuery(c.env, c.get("tenantId"), (db) =>
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

inventarioRoutes.put("/productos/:id/alergenos", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_producto inválido");
	const p = await parseBody(c, S.setAlergenosSchema);
	if (!p.ok) return p.res;
	await apply(c, cmd.setAlergenosProducto(id, p.data));
	return c.json({ ok: true });
});

inventarioRoutes.post("/lotes", async (c) => {
	const p = await parseBody(c, S.createLoteSchema);
	if (!p.ok) return p.res;
	const id = await apply(c, cmd.createLote(p.data));
	return c.json({ id_lote: id });
});

inventarioRoutes.put("/lotes/:id", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_lote inválido");
	const p = await parseBody(c, S.updateLoteSchema);
	if (!p.ok) return p.res;
	// El disponible previo es el delta del movimiento de auditoría (INV-01b).
	const info = await tenantQuery(c.env, c.get("tenantId"), (db) => q.getLoteStock(db, id));
	if (!info) return c.json({ error: "Lote no encontrado" }, 404);
	await apply(c, cmd.updateLote(id, { ...p.data, id_lote: id }, info.stock_disponible));
	return c.json({ ok: true });
});

inventarioRoutes.patch("/lotes/:id", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_lote inválido");
	const p = await parseBody(c, S.ajusteLoteSchema);
	if (!p.ok) return p.res;
	// El disponible previo es el delta del movimiento de auditoría (INV-01b).
	const info = await tenantQuery(c.env, c.get("tenantId"), (db) => q.getLoteStock(db, id));
	if (!info) return c.json({ error: "Lote no encontrado" }, 404);
	await apply(c, cmd.ajustarLote(id, p.data, info.stock_disponible));
	return c.json({ ok: true });
});
