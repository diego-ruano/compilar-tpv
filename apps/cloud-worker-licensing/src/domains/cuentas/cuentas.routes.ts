// src/domains/cuentas/cuentas.routes.ts

import { Hono } from "hono";
import { z } from "zod";

import type { Env } from "../../env";
import { applyViaHub, HubError, type ApplyCommand } from "../../lib/hub";
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

type Ctx = { Bindings: Env; Variables: TenantVars };

export const cuentasRoutes = new Hono<Ctx>();

cuentasRoutes.use("*", tenantAuth);

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

cuentasRoutes.get("/entradas", async (c) => {
	const p = S.listadoSchema.parse({
		del: c.req.query("del"),
		al: c.req.query("al"),
		q: c.req.query("q"),
		page: c.req.query("page"),
		page_size: c.req.query("page_size"),
	});
	return c.json(
		await tenantQuery(c, (db) =>
			q.entradas(db, p.del, p.al, p.q, p.page, p.page_size),
		),
	);
});

cuentasRoutes.get("/salidas", async (c) => {
	const p = S.listadoSchema.parse({
		del: c.req.query("del"),
		al: c.req.query("al"),
		q: c.req.query("q"),
		page: c.req.query("page"),
		page_size: c.req.query("page_size"),
	});
	return c.json(
		await tenantQuery(c, (db) =>
			q.salidas(db, p.del, p.al, p.q, p.page, p.page_size),
		),
	);
});

cuentasRoutes.get("/resumen", async (c) => {
	const p = S.listadoSchema.parse({
		del: c.req.query("del"),
		al: c.req.query("al"),
		q: c.req.query("q"),
	});
	return c.json(
		await tenantQuery(c, (db) =>
			q.resumen(db, p.del, p.al, p.q),
		),
	);
});

cuentasRoutes.post("/gastos", async (c) => {
	const veto = await soloLaMainEscribeCaja(c);
	if (veto) return veto;
	const p = await parseBody(c, S.createGastoSchema);
	if (!p.ok) return p.res;
	const id = await apply(c, cmd.createGasto(p.data));
	return c.json({ ok: true, id_gasto: id });
});

cuentasRoutes.put("/gastos/:id", async (c) => {
	const veto = await soloLaMainEscribeCaja(c);
	if (veto) return veto;
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_gasto invalido");
	const p = await parseBody(c, S.updateGastoSchema);
	if (!p.ok) return p.res;
	await apply(c, cmd.updateGasto(id, p.data));
	return c.json({ ok: true });
});

cuentasRoutes.delete("/gastos/:id", async (c) => {
	const veto = await soloLaMainEscribeCaja(c);
	if (veto) return veto;
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_gasto invalido");
	await apply(c, cmd.deleteGasto(id));
	return c.json({ ok: true });
});

cuentasRoutes.put("/pagos/:id", async (c) => {
	const veto = await soloLaMainEscribeCaja(c);
	if (veto) return veto;
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_pago invalido");
	const p = await parseBody(c, S.updatePagoSchema);
	if (!p.ok) return p.res;
	await apply(c, cmd.updatePago(id, p.data));
	return c.json({ ok: true });
});

// POST y no DELETE: anular ya no borra nada (CUENTA-07). Marca el cobro, deja quién y por qué, y
// devuelve sus líneas a la comanda. Un `DELETE` diría lo contrario de lo que hace.
cuentasRoutes.post("/pagos/:id/anular", async (c) => {
	const veto = await soloLaMainEscribeCaja(c);
	if (veto) return veto;
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_pago invalido");
	const p = await parseBody(c, S.anularPagoSchema);
	if (!p.ok) return p.res;
	await apply(c, cmd.anularPago(id, p.data));
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
	if (id == null) return badRequest(c, "id_cierre invalido");
	return c.json(
		await tenantQuery(c, (db) => q.detalleCierre(db, id)),
	);
});
