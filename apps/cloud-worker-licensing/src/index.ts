// src/index.ts
//
// Entry del worker `tpv-api` (fusión de los antiguos `tpv-server` + `tpv-licensing`).
//
// La API se construye con Hono y se organiza de forma modular: un router
// principal que monta subrouters por módulo (de momento sólo `pairing`; el resto
// de dominios —mesas, venta rápida, etc.— se migrarán más adelante).
//
// Rutas servidas aquí (Hono):
//   - GET  /health
//   - GET  /ws                  → upgrade WebSocket al Durable Object TenantHub
//   - POST /v1/pair/*           → emparejamiento Main/Handy (routes/pairing.ts)
//   - POST /v1/device/revoke    → revocación de dispositivo (+ corte del WS)
//
// Todo lo demás (activación de licencia, webhook de Lemon, status/validate, y los
// endpoints internos heredados) se delega al handler de licensing previo, que se
// mantiene intacto como fallthrough hasta que se migre también a Hono.

import { Hono } from "hono";

import type { Env } from "./env";
import { getDb } from "./server/db";
import {
	json,
	unauthorized,
	serverError,
	corsHeaders,
} from "./server/utils/response";
import { verifyJwtHs256 } from "./server/middleware/jwtHs256";

import { pairingRoutes } from "./routes/pairing";
import { clientesRoutes } from "./domains/clientes/clientes.routes";
import { configuracionRoutes } from "./domains/configuracion/configuracion.routes";
import { cuentasRoutes } from "./domains/cuentas/cuentas.routes";
import { imagesRoutes } from "./domains/images/images.routes";
import { inventarioRoutes } from "./domains/inventario/inventario.routes";
import { loginRoutes } from "./domains/login/login.routes";
import { mesasRoutes } from "./domains/mesas/mesas.routes";
import { proveedoresRoutes } from "./domains/proveedores/proveedores.routes";
import { reservasRoutes } from "./domains/reservas/reservas.routes";
import { statsRoutes } from "./domains/stats/stats.routes";
import { syncRoutes } from "./domains/sync/sync.routes";
import { tareasRoutes } from "./domains/tareas/tareas.routes";
import { trabajadoresRoutes } from "./domains/trabajadores/trabajadores.routes";
import { ventaRapidaRoutes } from "./domains/venta_rapida/venta_rapida.routes";
import { handleRevokeDevice } from "./server/endpoints/rest/pairing/revokeDevice";
import { handleListDevices } from "./server/endpoints/rest/pairing/listDevices";

import legacyLicensing from "./server/index";

// El Durable Object vive ahora en este worker (antes en `tpv-server`).
export { TenantHub } from "./durableObjects/tenantHub";

function readBearerMaybe(req: Request): string {
	const h = req.headers.get("authorization") || "";
	const m = h.match(/^Bearer\s+(.+)$/i);
	return m?.[1] || "";
}

const app = new Hono<{ Bindings: Env }>();

// ---------------- CORS preflight ----------------
app.options("*", (c) =>
	new Response(null, { status: 204, headers: corsHeaders(c.req.raw) }),
);

// ---------------- Health ----------------
app.get("/health", (c) =>
	json({ ok: true, service: "tpv-api", ts: Date.now() }, 200, c.req.raw),
);

// ---------------- WebSocket → TenantHub ----------------
app.get("/ws", async (c) => {
	const request = c.req.raw;
	const env = c.env;

	try {
		const dbCentral = getDb(env);

		const url = new URL(request.url);
		const tokenQ = url.searchParams.get("token") || "";
		const token = tokenQ || readBearerMaybe(request);
		if (!token) return unauthorized(request, "missing_token");

		const payload = await verifyJwtHs256(token, env.LICENSE_JWT_SECRET);

		const tenantId = String((payload as any).tenantId || "");
		const deviceId = String((payload as any).deviceId || "");
		const roleFromToken = String((payload as any).role || "unknown");

		if (!tenantId || !deviceId) {
			return unauthorized(request, "invalid_token_claims");
		}

		const r = await dbCentral.execute({
			sql: `
				SELECT revoked_at_ms, role, device_pubkey_b64
				FROM devices
				WHERE tenant_id=? AND device_id=?
				LIMIT 1
			`,
			args: [tenantId, deviceId],
		});

		const row = r.rows?.[0] as any | undefined;
		if (!row) return unauthorized(request, "device_not_registered");
		if (row.revoked_at_ms) return unauthorized(request, "device_revoked");

		const roleFinal = String(row.role || roleFromToken || "unknown");
		const pubB64 = String(row.device_pubkey_b64 || "").trim();

		const id = env.TenantHub.idFromName(tenantId);
		const stub = env.TenantHub.get(id);

		const doUrl = new URL(request.url);
		doUrl.pathname = "/ws";

		const doReq0 = new Request(doUrl.toString(), request);
		const h = new Headers(doReq0.headers);
		h.set("x-tenant-id", tenantId);
		h.set("x-device-id", deviceId);
		h.set("x-role", roleFinal);
		if (pubB64) h.set("x-device-pubkey-b64", pubB64);

		return await stub.fetch(new Request(doReq0, { headers: h }));
	} catch (e: any) {
		return serverError(request, "internal_error", {
			message: String(e?.message || e),
			name: e?.name,
			stack: e?.stack,
		});
	}
});

// ---------------- Pairing (Main + Handy) ----------------
app.route("/v1/pair", pairingRoutes);

// ---------------- Negocio (Handy) ----------------
app.route("/v1/clientes", clientesRoutes);
app.route("/v1/configuracion", configuracionRoutes);
app.route("/v1/cuentas", cuentasRoutes);
app.route("/v1/images", imagesRoutes);
app.route("/v1/inventario", inventarioRoutes);
app.route("/v1/login", loginRoutes);
app.route("/v1/mesas", mesasRoutes);
app.route("/v1/proveedores", proveedoresRoutes);
app.route("/v1/reservas", reservasRoutes);
app.route("/v1/stats", statsRoutes);
app.route("/v1/sync", syncRoutes);
app.route("/v1/tareas", tareasRoutes);
app.route("/v1/trabajadores", trabajadoresRoutes);
app.route("/v1/venta-rapida", ventaRapidaRoutes);

// ---------------- Gestión de dispositivos ----------------
app.post("/v1/device/list", (c) =>
	handleListDevices(c.req.raw, c.env, getDb(c.env)),
);

app.post("/v1/device/revoke", (c) =>
	handleRevokeDevice(c.req.raw, c.env, getDb(c.env), c.env.TenantHub),
);

// ---------------- Fallthrough: licensing heredado ----------------
// Activación de licencia, webhook de Lemon, status/validate, e internos.
// Se mantiene tal cual hasta migrarlo a Hono.
app.all("*", (c) => legacyLicensing.fetch(c.req.raw, c.env as any));

// Traduce los errores con status (p. ej. HubError del DO: main_offline,
// idempotency_*) a JSON; el resto cae a un 500 con detalle.
app.onError((err, c) => {
	const status = (err as any)?.status;
	if (typeof status === "number") {
		return c.json(
			{ error: (err as any)?.code || err.message || "error" },
			status as any,
		);
	}
	return serverError(c.req.raw, "internal_error", {
		message: String((err as any)?.message || err),
	});
});

export default app;
