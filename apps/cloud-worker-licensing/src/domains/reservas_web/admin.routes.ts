// src/domains/reservas_web/admin.routes.ts
//
// Reservas desde la web: lo que administra el proveedor, no el bar (docs/estudios/reservas-web.md
// §3.2). Montado en `/v1/admin/reservas-web` detrás de `requireAdmin`, y con su CLI en
// `scripts/tpv-license.mjs` (`pnpm reservas-web:*`). Todo queda en `admin_audit`.
//
//   GET  /:tenantId                  → la clave activa y los dominios autorizados
//   POST /:tenantId/dominios         { origen } → autoriza una web para incrustar el widget
//   POST /:tenantId/dominios/quitar  { origen } → la desautoriza
//   POST /:tenantId/revocar-clave    → revoca la clave: la línea pegada en la web deja de valer
//
// Los dominios los da de alta el proveedor porque el dueño del bar no sabe qué es un origen, y
// porque son la lista de `frame-ancestors`: quien los controla decide dónde se puede incrustar.

import { Hono } from "hono";
import * as z from "zod";

import type { Env } from "../../env";
import { cuerpo } from "../../lib/validacion";
import { getDb, type Sql } from "../../server/db";
import { auditAdmin } from "../../server/licenseStore";
import {
	claveActivaDelNegocio,
	dominiosDelNegocio,
	normalizarOrigen,
	ponerDominio,
	quitarDominio,
	revocarClave,
} from "./claves";

export const reservasWebAdminRoutes = new Hono<{ Bindings: Env }>();

const dominioSchema = z.object({
	origen: z.unknown().transform((v, ctx) => {
		const origen = typeof v === "string" ? normalizarOrigen(v) : null;
		if (!origen) {
			ctx.addIssue({
				code: "custom",
				message: "El origen es https://dominio[:puerto], sin ruta (o http://localhost para desarrollar).",
			});
			return z.NEVER;
		}
		return origen;
	}),
});

async function existeElNegocio(db: Sql, tenantId: string): Promise<boolean> {
	const rs = await db.execute({ sql: `SELECT 1 FROM tenants WHERE tenant_id = ?;`, args: [tenantId] });
	return (rs.rows?.length ?? 0) > 0;
}

function sinNegocio(c: any) {
	return c.json({ ok: false, error: "not_found", message: "No hay ningún negocio con ese id." }, 404);
}

reservasWebAdminRoutes.get("/:tenantId", async (c) => {
	const db = getDb(c.env);
	const tenantId = c.req.param("tenantId");
	if (!(await existeElNegocio(db, tenantId))) return sinNegocio(c);
	const [clave, dominios] = await Promise.all([
		claveActivaDelNegocio(db, tenantId),
		dominiosDelNegocio(db, tenantId),
	]);
	return c.json({ ok: true, tenantId, clave, dominios });
});

reservasWebAdminRoutes.post("/:tenantId/dominios", cuerpo(dominioSchema), async (c) => {
	const db = getDb(c.env);
	const tenantId = c.req.param("tenantId");
	const { origen } = c.req.valid("json");
	if (!(await existeElNegocio(db, tenantId))) return sinNegocio(c);
	await ponerDominio(db, tenantId, origen, Date.now());
	await auditAdmin(db, "reserva_web_dominio_poner", null, { tenantId, origen });
	return c.json({ ok: true, tenantId, origen, dominios: await dominiosDelNegocio(db, tenantId) });
});

reservasWebAdminRoutes.post("/:tenantId/dominios/quitar", cuerpo(dominioSchema), async (c) => {
	const db = getDb(c.env);
	const tenantId = c.req.param("tenantId");
	const { origen } = c.req.valid("json");
	if (!(await quitarDominio(db, tenantId, origen))) {
		return c.json({ ok: false, error: "not_found", message: "Ese negocio no tiene autorizado ese origen." }, 404);
	}
	await auditAdmin(db, "reserva_web_dominio_quitar", null, { tenantId, origen });
	return c.json({ ok: true, tenantId, origen, dominios: await dominiosDelNegocio(db, tenantId) });
});

reservasWebAdminRoutes.post("/:tenantId/revocar-clave", async (c) => {
	const db = getDb(c.env);
	const tenantId = c.req.param("tenantId");
	const clave = await revocarClave(db, tenantId, Date.now());
	if (!clave) {
		return c.json({ ok: false, error: "not_found", message: "Ese negocio no tiene ninguna clave activa." }, 404);
	}
	await auditAdmin(db, "reserva_web_revocar_clave", null, { tenantId, clave });
	return c.json({ ok: true, tenantId, revocada: clave });
});
