// src/domains/sync/sync.routes.ts
//
// Catch-up de la sincronización nube → Main. Cuando el WebSocket de la Main se reconecta tras
// un corte, la Main pide las operaciones que se perdió desde su último checkpoint (`Seq`). El
// DO ya registra cada escritura aplicada en `Sync_Changes` (Op_Id, Statements_Json resueltas,
// Seq monotono); aquí solo se sirven en orden.
//
// Solo la Main (rol tpv) consume este endpoint: es quien tiene la BD local que mantener al día.

import { Hono } from "hono";

import type { Env } from "../../env";
import { isTpvDevice } from "../../lib/deviceAuth";
import { tenantQuery } from "../../lib/tenantClient";
import { tenantAuth, type TenantVars } from "../../middleware/tenant";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const syncRoutes = new Hono<Ctx>();

syncRoutes.use("*", tenantAuth);

function rows(rs: any): any[] {
	const cols: string[] = rs?.columns ?? [];
	return (rs?.rows ?? []).map((r: any) => {
		if (r && typeof r === "object" && !Array.isArray(r)) return r;
		const o: Record<string, any> = {};
		cols.forEach((col, i) => {
			o[col] = r[i];
		});
		return o;
	});
}

function safeJsonParse(s: string): any {
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
}

// POST /v1/sync/changes  { since?: number, limit?: number }
// Devuelve las operaciones con Seq > since en orden ascendente.
syncRoutes.post("/changes", async (c) => {
	const okTpv = await isTpvDevice(c.env, c.get("tenantId"), c.get("deviceId"));
	if (!okTpv) return c.json({ error: "forbidden_not_tpv" }, 403);

	const body = await c.req.json().catch(() => ({}));
	const since = Math.max(0, Number((body as any)?.since ?? 0) || 0);
	const limit = Math.min(Math.max(1, Number((body as any)?.limit ?? 500) || 500), 1000);

	const items = await tenantQuery(c.env, c.get("tenantId"), async (db) => {
		const rs = await db.execute({
			sql: `
				SELECT Seq, Op_Id, Command_Name, Statements_Json, Device_Id, Created_At_Ms
				FROM Sync_Changes
				WHERE Seq > ?1
				ORDER BY Seq ASC
				LIMIT ?2;
			`,
			args: [since, limit],
		});

		return rows(rs).map((r: any) => ({
			seq: Number(r.Seq ?? r.seq ?? 0),
			opId: String(r.Op_Id ?? r.op_id ?? ""),
			command: String(r.Command_Name ?? r.command_name ?? ""),
			statements: safeJsonParse(String(r.Statements_Json ?? r.statements_json ?? "[]")) ?? [],
			deviceId: r.Device_Id ? String(r.Device_Id) : null,
			createdAtMs: Number(r.Created_At_Ms ?? r.created_at_ms ?? 0),
		}));
	});

	const nextSince = items.length ? items[items.length - 1].seq : since;
	return c.json({ ok: true, items, nextSince });
});
