// src/domains/reservas/reservas.routes.ts

import { Hono } from "hono";

import type { Env } from "../../env";
import { tenantQuery } from "../../lib/tenantClient";
import { tenantAuth, type TenantVars } from "../../middleware/tenant";

import * as cmd from "./reservas.commands";
import * as q from "./reservas.queries";
import * as S from "./reservas.schemas";
import { badRequest } from "../../server/utils/response";
import { consulta, cuerpo } from "../../lib/validacion";
import { apply, parseId } from "../../lib/rutas";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const reservasRoutes = new Hono<Ctx>();

reservasRoutes.use("*", tenantAuth);

reservasRoutes.get("/meta", async (c) =>
	c.json(await tenantQuery(c, (db) => q.meta(db))),
);

reservasRoutes.get("/mes", consulta(S.mesQuerySchema), async (c) => {
	const { desde, hasta } = c.req.valid("query");
	return c.json(await tenantQuery(c, (db) => q.mes(db, desde, hasta)));
});

reservasRoutes.post("/", cuerpo(S.reservaSaveSchema), async (c) => {
	const datos = c.req.valid("json");

	// RES-02: rechazar el doble booking del mismo hueco exacto (mesa+día+hora) antes de aplicar.
	// Una reserva sin mesa no ocupa ningún hueco, así que no puede solaparse con nadie.
	const solapa = datos.id_mesa
		? await tenantQuery(c, (db) =>
				q.haySolapeReserva(db, datos.id_mesa!, datos.dia_ymd, datos.hora, datos.id_reserva ?? null),
			)
		: false;
	if (solapa) {
		return c.json(
			{ error: "reserva_solapada", message: "Ya existe una reserva en esa mesa para ese día y hora." },
			409,
		);
	}

	const cliente = await tenantQuery(c, (db) =>
		q.findClienteReserva(db, datos.email, datos.telefono),
	);
	const id = await apply(c, cmd.saveReserva(datos, cliente));
	return c.json({ ok: true, id_reserva: id });
});

reservasRoutes.delete("/:id", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_reserva invalido");
	await apply(c, cmd.deleteReserva(id));
	return c.json({ ok: true });
});
