// src/domains/ws/ws.routes.ts
//
// SYNC-15: emisión de TICKETS efímeros de un solo uso para abrir el WebSocket.
//
// Los navegadores no permiten cabeceras en `new WebSocket(...)`, así que el token viajaba en la
// URL (`/ws?token=<jwt>`) y quedaba expuesto en logs de proxies/CF. En su lugar, el cliente pide
// aquí (petición REST firmada, sin exponer nada en la URL) un ticket aleatorio de corta vida y
// UN SOLO USO, y abre el WS con `?ticket=<ticket>`. El handler de `/ws` lo consume atómicamente.

import { Hono } from "hono";

import type { Env } from "../../env";
import { getDb } from "../../server/db";
import { bytesToB64 } from "../../server/utils/base64";
import { tenantAuth, type TenantVars } from "../../middleware/tenant";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const wsRoutes = new Hono<Ctx>();

wsRoutes.use("*", tenantAuth);

// Vida útil del ticket: suficiente para el round trip mint→connect, no más. Un ticket filtrado
// caduca casi de inmediato (y además es de un solo uso: si el cliente legítimo ya lo canjeó, un
// replay no encuentra nada que consumir).
const TICKET_TTL_MS = 30_000;

// POST /v1/ws/ticket → { ok, ticket, expiresInMs }
wsRoutes.post("/ticket", async (c) => {
	const db = getDb(c.env);
	const tenantId = c.get("tenantId");
	const deviceId = c.get("deviceId");
	const now = Date.now();

	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	const ticket = bytesToB64(bytes);

	await db.execute(`
		CREATE TABLE IF NOT EXISTS Ws_Tickets (
			ticket TEXT PRIMARY KEY,
			tenant_id TEXT NOT NULL,
			device_id TEXT NOT NULL,
			expires_at_ms INTEGER NOT NULL
		);
	`);
	// Limpieza oportunista de tickets caducados (mantiene la tabla acotada sin job aparte).
	await db.execute({
		sql: `DELETE FROM Ws_Tickets WHERE expires_at_ms < ?;`,
		args: [now],
	});
	await db.execute({
		sql: `INSERT INTO Ws_Tickets (ticket, tenant_id, device_id, expires_at_ms) VALUES (?1, ?2, ?3, ?4);`,
		args: [ticket, tenantId, deviceId, now + TICKET_TTL_MS],
	});

	return c.json({ ok: true, ticket, expiresInMs: TICKET_TTL_MS });
});
