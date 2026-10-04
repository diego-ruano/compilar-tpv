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

// RI-61: ¿ese teléfono o ese email ya son de un cliente? La pantalla pregunta antes de asignarle la
// reserva. Sin ninguno de los dos no hay nada que buscar.
reservasRoutes.get("/buscar-cliente", consulta(S.buscarClienteSchema), async (c) => {
	const { telefono, email } = c.req.valid("query");
	if (!telefono && !email) return c.json(null);
	return c.json(await tenantQuery(c, (db) => q.buscarCliente(db, telefono, email)));
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

	// RI-61: el cliente llega decidido (ninguno, uno existente o uno nuevo); aquí no se casa nada.
	const cliente = await tenantQuery(c, (db) => q.resolverCliente(db, datos));
	if ("error" in cliente) {
		return c.json({ error: cliente.error }, cliente.error === "email_duplicado" ? 409 : 404);
	}
	const id = await apply(c, cmd.saveReserva(datos, cliente));
	return c.json({ ok: true, id_reserva: id });
});

reservasRoutes.delete("/:id", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_reserva invalido");
	await apply(c, cmd.deleteReserva(id));
	return c.json({ ok: true });
});
