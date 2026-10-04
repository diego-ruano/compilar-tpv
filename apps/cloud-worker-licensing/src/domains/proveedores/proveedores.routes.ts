// src/domains/proveedores/proveedores.routes.ts

import { Hono } from "hono";

import type { Env } from "../../env";
import { tenantQuery } from "../../lib/tenantClient";
import { tenantAuth, type TenantVars } from "../../middleware/tenant";

import * as cmd from "./proveedores.commands";
import * as q from "./proveedores.queries";
import * as S from "./proveedores.schemas";
import { badRequest } from "../../server/utils/response";
import { cuerpo } from "../../lib/validacion";
import { apply, parseId } from "../../lib/rutas";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const proveedoresRoutes = new Hono<Ctx>();

proveedoresRoutes.use("*", tenantAuth);

proveedoresRoutes.get("/", async (c) =>
	c.json(await tenantQuery(c, (db) => q.getAll(db))),
);

proveedoresRoutes.get("/categorias", async (c) =>
	c.json(await tenantQuery(c, (db) => q.getCategorias(db))),
);

proveedoresRoutes.get("/productos", async (c) =>
	c.json(await tenantQuery(c, (db) => q.getProductosAll(db))),
);

proveedoresRoutes.get("/:id/productos", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_proveedor invalido");
	return c.json(
		await tenantQuery(c, (db) => q.getProductos(db, id)),
	);
});

proveedoresRoutes.post("/", cuerpo(S.proveedorSaveSchema), async (c) => {
	const datos = c.req.valid("json");
	const id = await apply(c, cmd.guardarProveedor(datos));
	return c.json({ ok: true, id_proveedor: id });
});

proveedoresRoutes.delete("/:id", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_proveedor invalido");
	await apply(c, cmd.eliminarProveedor(id));
	return c.json({ ok: true });
});

proveedoresRoutes.put("/:id/vinculos", cuerpo(S.setVinculosSchema), async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_proveedor invalido");
	const datos = c.req.valid("json");
	await apply(c, cmd.setVinculos(id, datos));
	return c.json({ ok: true });
});
