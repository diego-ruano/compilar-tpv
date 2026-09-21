// src/domains/stats/stats.routes.ts

import { Hono } from "hono";

import type { Env } from "../../env";
import { tenantQuery } from "../../lib/tenantClient";
import { tenantAuth, type TenantVars } from "../../middleware/tenant";

import * as q from "./stats.queries";
import { rangeSchema, turnoSchema } from "./stats.schemas";
import { parseId } from "../../lib/rutas";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const statsRoutes = new Hono<Ctx>();

statsRoutes.use("*", tenantAuth);

function parseRange(raw: string | undefined) {
	return rangeSchema.parse(raw || "hoy");
}

statsRoutes.get("/mesas", async (c) => {
	const range = parseRange(c.req.query("range"));
	return c.json(await tenantQuery(c, (db) => q.mesas(db, range)));
});

statsRoutes.get("/productos/categorias", async (c) =>
	c.json(await tenantQuery(c, (db) => q.listCategorias(db))),
);

statsRoutes.get("/productos", async (c) => {
	const range = parseRange(c.req.query("range"));
	const top = parseId(c.req.query("categoria_top_id"));
	const worst = parseId(c.req.query("categoria_worst_id"));
	return c.json(
		await tenantQuery(c, (db) =>
			q.productos(db, range, top, worst),
		),
	);
});

statsRoutes.get("/reservas", async (c) => {
	const range = parseRange(c.req.query("range"));
	const turno = turnoSchema.parse(c.req.query("turno") || "TODOS");
	return c.json(
		await tenantQuery(c, (db) => q.reservas(db, range, turno)),
	);
});

statsRoutes.get("/trabajadores", async (c) => {
	const range = parseRange(c.req.query("range"));
	return c.json(
		await tenantQuery(c, (db) => q.trabajadores(db, range)),
	);
});

statsRoutes.get("/clientes", async (c) => {
	const range = parseRange(c.req.query("range"));
	return c.json(await tenantQuery(c, (db) => q.clientes(db, range)));
});

statsRoutes.get("/proveedores", async (c) => {
	const range = parseRange(c.req.query("range"));
	return c.json(
		await tenantQuery(c, (db) => q.proveedores(db, range)),
	);
});
