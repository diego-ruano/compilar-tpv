// src/domains/cuentas/cuentas.routes.ts

import { Hono } from "hono";

import type { Env } from "../../env";
import { tenantQuery } from "../../lib/tenantClient";
import {
	soloLaMainEscribeCaja,
	tenantAuth,
	type TenantVars,
} from "../../middleware/tenant";

import * as cmd from "./cuentas.commands";
import * as q from "./cuentas.queries";
import * as S from "./cuentas.schemas";
import { badRequest } from "../../server/utils/response";
import { cuerpo } from "../../lib/validacion";
import { apply, lecturaPorPost, parseId } from "../../lib/rutas";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const cuentasRoutes = new Hono<Ctx>();

// AUD-27: lecturas por POST. Lo que se busca en Cuentas (el nombre de un cliente, un concepto) va
// en el cuerpo, no en la URL.
cuentasRoutes.use("/entradas", lecturaPorPost());
cuentasRoutes.use("/salidas", lecturaPorPost());
cuentasRoutes.use("/resumen", lecturaPorPost());
cuentasRoutes.use("*", tenantAuth);

cuentasRoutes.post("/entradas", cuerpo(S.listadoSchema), async (c) => {
	const p = c.req.valid("json");
	return c.json(
		await tenantQuery(c, (db) =>
			q.entradas(db, p.del, p.al, p.q, p.page_size, p.cursor),
		),
	);
});

cuentasRoutes.post("/salidas", cuerpo(S.listadoSchema), async (c) => {
	const p = c.req.valid("json");
	return c.json(
		await tenantQuery(c, (db) =>
			q.salidas(db, p.del, p.al, p.q, p.page_size, p.cursor),
		),
	);
});

cuentasRoutes.post("/resumen", cuerpo(S.listadoSchema), async (c) => {
	const p = c.req.valid("json");
	return c.json(
		await tenantQuery(c, (db) =>
			q.resumen(db, p.del, p.al, p.q),
		),
	);
});

cuentasRoutes.post("/gastos", soloLaMainEscribeCaja, cuerpo(S.createGastoSchema), async (c) => {
	const datos = c.req.valid("json");
	const id = await apply(c, cmd.createGasto(datos));
	return c.json({ ok: true, id_gasto: id });
});

cuentasRoutes.put("/gastos/:id", soloLaMainEscribeCaja, cuerpo(S.updateGastoSchema), async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_gasto_invalido");
	const datos = c.req.valid("json");
	await apply(c, cmd.updateGasto(id, datos));
	return c.json({ ok: true });
});

cuentasRoutes.delete("/gastos/:id", soloLaMainEscribeCaja, async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_gasto_invalido");
	await apply(c, cmd.deleteGasto(id));
	return c.json({ ok: true });
});

cuentasRoutes.put("/pagos/:id", soloLaMainEscribeCaja, cuerpo(S.updatePagoSchema), async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_pago_invalido");
	const datos = c.req.valid("json");
	await apply(c, cmd.updatePago(id, datos));
	return c.json({ ok: true });
});

// POST y no DELETE: anular ya no borra nada (CUENTA-07). Marca el cobro, deja quién y por qué, y
// devuelve sus líneas a la comanda. Un `DELETE` diría lo contrario de lo que hace.
cuentasRoutes.post("/pagos/:id/anular", soloLaMainEscribeCaja, cuerpo(S.anularPagoSchema), async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_pago_invalido");
	const datos = c.req.valid("json");
	await apply(c, cmd.anularPago(id, datos));
	return c.json({ ok: true });
});

/* =========================================================
   Cierre de caja (arqueo) — SOLO LECTURA desde la Handy (CUENTA-06)
   Cerrar y reabrir viven en la Main: aquí no hay ruta que los haga.
========================================================= */

// Va ANTES de "/cierres/:id" a propósito: si no, "ultimo" entraría por el parámetro y se buscaría un
// cierre con ese id.
cuentasRoutes.get("/cierres/ultimo", async (c) => {
	return c.json(
		await tenantQuery(c, (db) => q.ultimoCierre(db)),
	);
});

cuentasRoutes.get("/cierres", async (c) => {
	const limite = Number(c.req.query("limite") ?? 50);
	return c.json(
		await tenantQuery(c, (db) =>
			q.listarCierres(db, Number.isFinite(limite) ? limite : 50),
		),
	);
});

cuentasRoutes.get("/cierres/:id", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_cierre_invalido");
	return c.json(
		await tenantQuery(c, (db) => q.detalleCierre(db, id)),
	);
});
