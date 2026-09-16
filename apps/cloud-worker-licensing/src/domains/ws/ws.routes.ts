// src/domains/ws/ws.routes.ts
//
// SYNC-15: emisión de TICKETS efímeros de un solo uso para abrir el WebSocket.
//
// Los navegadores no permiten cabeceras en `new WebSocket(...)`, así que el token viajaba en la
// URL (`/ws?token=<jwt>`) y quedaba expuesto en logs de proxies/CF. En su lugar, el cliente pide
// aquí (petición REST firmada, sin exponer nada en la URL) un ticket aleatorio de corta vida y
// UN SOLO USO, y abre el WS con `?ticket=<ticket>`. El handler de `/ws` lo consume atómicamente.

import { Hono, type Context } from "hono";

import type { Env } from "../../env";
import { getDb } from "../../server/db";
import { bytesToB64 } from "../../server/utils/base64";
import { forbidden } from "../../server/utils/response";
import { getLicenseByHash } from "../../server/licenseStore";
import {
	computeLicenseState,
	stateAllowsUse,
} from "../licensing/licensing.helpers";
import { tenantAuth, type TenantVars } from "../../middleware/tenant";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const wsRoutes = new Hono<Ctx>();

wsRoutes.use("*", tenantAuth);

/**
 * SYNC-17: ¿puede este dispositivo sincronizar AHORA?
 *
 * `tenantAuth` valida el JWT y la firma del dispositivo, pero el token dura 30 días: sin esta
 * comprobación, una licencia anulada hoy seguiría replicando hasta un mes. Como el WS es la puerta
 * por la que entra TODA la escritura remota, el ticket es el sitio natural para preguntarlo: una
 * consulta por conexión, no por petición.
 *
 * El estado lo deriva `computeLicenseState`, el mismo que firma `/v1/license/status`: no hay una
 * segunda idea de "licencia válida" viviendo aquí.
 *
 * El `deviceId` solo se le pasa cuando quien pregunta es la **Main**. Ese argumento existe para
 * detectar el traslado de licencia a otro equipo (§6.4), y una Handy nunca es `main_device_id`:
 * pasárselo la marcaría como desplazada y bloquearía todos los Handy del tenant.
 */
async function licenciaPermiteSincronizar(
	c: Context<Ctx>,
): Promise<Response | null> {
	const db = getDb(c.env);
	const tenantId = c.get("tenantId");
	const deviceId = c.get("deviceId");

	const lic = await getLicenseByHash(db, c.get("licHash"));
	if (!lic) return forbidden(c.req.raw, "license_not_found");

	const esMain = lic.main_device_id === deviceId;
	const rs = await db.execute({
		sql: `SELECT role FROM devices WHERE tenant_id=? AND device_id=? LIMIT 1;`,
		args: [tenantId, deviceId],
	});
	const rol = String((rs.rows?.[0] as any)?.role || "").toLowerCase();

	// Un dispositivo con rol `tpv` que NO es el `main_device_id` es un Main desplazado: la licencia
	// se activó en otro equipo y este debe dejar de escribir (si no, dos Mains replicarían a la vez
	// sobre el mismo tenant).
	if (rol === "tpv" && !esMain) return forbidden(c.req.raw, "device_replaced");

	const estado = computeLicenseState(
		lic,
		esMain ? deviceId : (lic.main_device_id ?? deviceId),
		Date.now(),
	);
	if (!stateAllowsUse(estado)) {
		// `expiry_grace` SÍ pasa: durante la gracia el TPV sigue trabajando, y trabajar sin
		// sincronizar es la peor combinación posible (acumula outbox que quizá nunca suba).
		return forbidden(
			c.req.raw,
			estado === "revoked" ? "license_revoked" : "license_expired",
		);
	}

	return null;
}

// Vida útil del ticket: suficiente para el round trip mint→connect, no más. Un ticket filtrado
// caduca casi de inmediato (y además es de un solo uso: si el cliente legítimo ya lo canjeó, un
// replay no encuentra nada que consumir).
const TICKET_TTL_MS = 30_000;

// POST /v1/ws/ticket → { ok, ticket, expiresInMs }
wsRoutes.post("/ticket", async (c) => {
	// SYNC-17: la licencia manda. Se comprueba ANTES de emitir el ticket para no dar acceso al hub
	// a un dispositivo que no debería estar replicando.
	const veto = await licenciaPermiteSincronizar(c);
	if (veto) return veto;

	const db = getDb(c.env);
	const tenantId = c.get("tenantId");
	const deviceId = c.get("deviceId");
	const now = Date.now();

	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	const ticket = bytesToB64(bytes);

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
