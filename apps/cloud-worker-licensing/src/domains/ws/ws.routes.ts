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
import { vetoDeLicencia } from "../../lib/licenciaEnUso";
import { forbidden } from "../../server/utils/response";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const wsRoutes = new Hono<Ctx>();

wsRoutes.use("*", tenantAuth);

// REV-12: aquí vivía `licenciaPermiteSincronizar`, que comprobaba la licencia antes de emitir el
// ticket (SYNC-17). Se ha mudado a `lib/licenciaEnUso.ts` porque ahora la aplica `tenantAuth` a
// TODAS las rutas de negocio: tenerla sólo delante del hub dejaba pasar, con una licencia anulada o
// caducada, el correo con nuestro dominio, las subidas a R2, el volcado de `/v1/sync/bootstrap` y
// las lecturas de la Handy — todo con un JWT de 30 días que `/v1/license/status` renueva cada seis
// horas. El razonamiento de entonces sigue valiendo, sólo que el sitio natural resultó ser otro.

// Vida útil del ticket: suficiente para el round trip mint→connect, no más. Un ticket filtrado
// caduca casi de inmediato (y además es de un solo uso: si el cliente legítimo ya lo canjeó, un
// replay no encuentra nada que consumir).
const TICKET_TTL_MS = 30_000;

// POST /v1/ws/ticket → { ok, ticket, expiresInMs }
wsRoutes.post("/ticket", async (c) => {
	// SYNC-17: la licencia manda, y se comprueba ANTES de emitir el ticket para no dar acceso al
	// hub a un dispositivo que no debería estar replicando.
	//
	// REV-12: `tenantAuth` ya la ha comprobado, pero con la caché de un minuto. Aquí se repite sin
	// ella: es la petición con la que reconecta la Main a la que `revoke` acaba de cerrar el socket,
	// y el «sí» guardado de hace unos segundos le devolvía el socket con la licencia ya anulada.
	const veto = await vetoDeLicencia(c, { sinCache: true });
	if (veto) return forbidden(c.req.raw, veto);

	const db = getDb(c.env);
	const tenantId = c.get("tenantId");
	const deviceId = c.get("deviceId");
	const now = Date.now();

	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	const ticket = bytesToB64(bytes);

	// Limpieza oportunista de tickets caducados (mantiene la tabla acotada sin job aparte), en el
	// mismo viaje a la base central que el alta del ticket.
	await db.batch(
		[
			{ sql: `DELETE FROM Ws_Tickets WHERE expires_at_ms < ?;`, args: [now] },
			{
				sql: `INSERT INTO Ws_Tickets (ticket, tenant_id, device_id, expires_at_ms) VALUES (?1, ?2, ?3, ?4);`,
				args: [ticket, tenantId, deviceId, now + TICKET_TTL_MS],
			},
		],
	);

	return c.json({ ok: true, ticket, expiresInMs: TICKET_TTL_MS });
});
