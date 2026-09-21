// src/domains/clientes/clientes.routes.ts

import { Hono } from "hono";

import type { Env } from "../../env";
import { tenantQuery } from "../../lib/tenantClient";
import { tenantAuth, type TenantVars } from "../../middleware/tenant";

import * as cmd from "./clientes.commands";
import * as q from "./clientes.queries";
import * as S from "./clientes.schemas";
import { badRequest } from "../../server/utils/response";
import { cuerpo } from "../../lib/validacion";
import { apply, parseId } from "../../lib/rutas";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const clientesRoutes = new Hono<Ctx>();

clientesRoutes.use("*", tenantAuth);

clientesRoutes.get("/overview", async (c) => {
	const ranking = c.req.query("ranking") || "todos";
	return c.json(
		await tenantQuery(c, (db) => q.overview(db, ranking)),
	);
});

clientesRoutes.get("/:id/form", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_cliente invalido");
	return c.json(await tenantQuery(c, (db) => q.form(db, id)));
});

clientesRoutes.post("/", cuerpo(S.createClienteSchema), async (c) => {
	const datos = c.req.valid("json");
	// CLI-04: rechazar email duplicado con un 409 limpio antes de aplicar (el índice
	// único ux_clientes_email es el backstop real).
	if (datos.email) {
		const dup = await tenantQuery(c, (db) =>
			q.emailEnUso(db, datos.email!, datos.id_cliente),
		);
		if (dup) return c.json({ error: "email_duplicado" }, 409);
	}
	const id = await apply(c, cmd.createCliente(datos));
	return c.json({ ok: true, id_cliente: id });
});

clientesRoutes.put("/:id", cuerpo(S.updateClienteSchema), async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_cliente invalido");
	const datos = c.req.valid("json");
	if (datos.email) {
		const dup = await tenantQuery(c, (db) =>
			q.emailEnUso(db, datos.email!, id),
		);
		if (dup) return c.json({ error: "email_duplicado" }, 409);
	}
	await apply(c, cmd.updateCliente(id, datos));
	return c.json({ ok: true });
});
