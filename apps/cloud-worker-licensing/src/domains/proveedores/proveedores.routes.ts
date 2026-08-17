// src/domains/proveedores/proveedores.routes.ts

import { Hono } from "hono";
import { z } from "zod";

import type { Env } from "../../env";
import { applyViaHub, HubError, type ApplyCommand } from "../../lib/hub";
import { tenantQuery } from "../../lib/tenantClient";
import { tenantAuth, type TenantVars } from "../../middleware/tenant";

import * as cmd from "./proveedores.commands";
import * as q from "./proveedores.queries";
import * as S from "./proveedores.schemas";
import { badRequest } from "../../server/utils/response";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const proveedoresRoutes = new Hono<Ctx>();

proveedoresRoutes.use("*", tenantAuth);

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

proveedoresRoutes.get("/", async (c) =>
	c.json(await tenantQuery(c.env, c.get("tenantId"), (db) => q.getAll(db))),
);

proveedoresRoutes.get("/categorias", async (c) =>
	c.json(await tenantQuery(c.env, c.get("tenantId"), (db) => q.getCategorias(db))),
);

proveedoresRoutes.get("/productos", async (c) =>
	c.json(await tenantQuery(c.env, c.get("tenantId"), (db) => q.getProductosAll(db))),
);

proveedoresRoutes.get("/:id/productos", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_proveedor invalido");
	return c.json(
		await tenantQuery(c.env, c.get("tenantId"), (db) => q.getProductos(db, id)),
	);
});

proveedoresRoutes.post("/", async (c) => {
	const p = await parseBody(c, S.proveedorSaveSchema);
	if (!p.ok) return p.res;
	const id = await apply(c, cmd.guardarProveedor(p.data));
	return c.json({ ok: true, id_proveedor: id });
});

proveedoresRoutes.delete("/:id", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_proveedor invalido");
	await apply(c, cmd.eliminarProveedor(id));
	return c.json({ ok: true });
});

proveedoresRoutes.put("/:id/vinculos", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_proveedor invalido");
	const p = await parseBody(c, S.setVinculosSchema);
	if (!p.ok) return p.res;
	await apply(c, cmd.setVinculos(id, p.data));
	return c.json({ ok: true });
});

proveedoresRoutes.post("/productos", async (c) => {
	const p = await parseBody(c, S.createProductoSchema);
	if (!p.ok) return p.res;
	const id = await apply(c, cmd.crearProducto(p.data));
	return c.json({ ok: true, id_producto: id });
});
