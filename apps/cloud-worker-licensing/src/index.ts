// src/index.ts
//
// Entry del worker `tpv-api` (fusión de los antiguos `tpv-server` + `tpv-licensing`).
//
// La API se construye con Hono y se organiza de forma modular: un router
// principal que monta subrouters por módulo (pairing, dominios de negocio,
// licencias, etc.). El antiguo handler legacy `server/index.ts` y su fallthrough
// `app.all("*")` se eliminaron: las licencias están ahora en domains/licensing.
//
// Rutas servidas aquí (Hono):
//   - GET  /health
//   - GET  /ws                  → upgrade WebSocket al Durable Object TenantHub
//   - POST /v1/pair/*           → emparejamiento Main/Handy (routes/pairing.ts)
//   - POST /v1/device/revoke    → revocación de dispositivo (+ corte del WS)
//   - /v1/license/*             → activación, cambio de dispositivo, status firmado, refresh
//   - POST /v1/stripe/webhook   → compras (emite/extiende licencia)
//   - /v1/admin/licenses/*      → alta manual (token admin)

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import * as Sentry from "@sentry/cloudflare";

import type { Env } from "./env";
import { sentryOptions } from "./observability/sentry";
import { getDb } from "./server/db";
import { cargarDevice, estaRevocado } from "./lib/deviceAuth";
import {
	json,
	unauthorized,
	serverError,
	corsHeaders,
} from "./server/utils/response";

import { avisarDeCaducidades } from "./domains/licensing/avisosDeCaducidad";
import { purgarBaseCentral } from "./server/purga";
import { pairingRoutes } from "./domains/pairing/pairing.routes";
import { clientesRoutes } from "./domains/clientes/clientes.routes";
import { configuracionRoutes } from "./domains/configuracion/configuracion.routes";
import { cuentasRoutes } from "./domains/cuentas/cuentas.routes";
import { imagesRoutes } from "./domains/images/images.routes";
import { inventarioRoutes } from "./domains/inventario/inventario.routes";
import { loginRoutes } from "./domains/login/login.routes";
import { mesasRoutes } from "./domains/mesas/mesas.routes";
import { notificacionesRoutes } from "./domains/notificaciones/notificaciones.routes";
import { proveedoresRoutes } from "./domains/proveedores/proveedores.routes";
import { reservasRoutes } from "./domains/reservas/reservas.routes";
import { statsRoutes } from "./domains/stats/stats.routes";
import { syncRoutes } from "./domains/sync/sync.routes";
import { wsRoutes } from "./domains/ws/ws.routes";
import { tareasRoutes } from "./domains/tareas/tareas.routes";
import { trabajadoresRoutes } from "./domains/trabajadores/trabajadores.routes";
import { ventaRapidaRoutes } from "./domains/venta_rapida/venta_rapida.routes";
import { updatesRoutes } from "./domains/updates/updates.routes";
import { dispositivosRoutes } from "./domains/pairing/dispositivos.routes";
import { emailRoutes } from "./domains/email/email.routes";
import { licenseRoutes } from "./domains/licensing/licensing.routes";
import { adminRoutes } from "./domains/admin/admin.routes";
import { stripeRoutes } from "./domains/stripe/stripe.routes";
import { telemetryRoutes } from "./domains/telemetry/telemetry.routes";
import { completarErrores } from "./middleware/completarErrores";

// El Durable Object vive ahora en este worker (antes en `tpv-server`). Se instrumenta con Sentry
// para capturar las excepciones de su ciclo de vida (apply idempotente, WebSocket, broadcast).
// `TenantHub` es un DO de estilo CLÁSICO (clase con método `fetch`, no `extends DurableObject`):
// la instrumentación funciona en runtime con cualquier DO, pero la firma de tipos del SDK espera
// la clase base moderna, de ahí el cast acotado.
import { TenantHub as TenantHubClass } from "./durableObjects/tenantHub";
export const TenantHub = Sentry.instrumentDurableObjectWithSentry(
	sentryOptions,
	TenantHubClass as any,
);

const app = new Hono<{ Bindings: Env }>();

// Todas las respuestas de error salen con `code` y, si lo hay, `message` legible. Va el primero
// para envolver también las que produce `onError`.
app.use("*", completarErrores);

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
		const ticketQ = url.searchParams.get("ticket") || "";

		// SYNC-15: el WS SOLO se abre con un ticket efímero de un solo uso (canjeado por REST firmado
		// en `/v1/ws/ticket`). Ya no aceptamos el JWT en la URL: nunca viaja un secreto por el query
		// string. Consumimos el ticket ATÓMICAMENTE (DELETE ... RETURNING): un replay no encuentra
		// nada que borrar.
		if (!ticketQ) return unauthorized(request, "missing_ticket");

		const now = Date.now();
		const rt = await dbCentral.execute({
			sql: `DELETE FROM Ws_Tickets WHERE ticket = ? RETURNING tenant_id, device_id, expires_at_ms;`,
			args: [ticketQ],
		});
		const trow = rt.rows?.[0] as any | undefined;
		if (!trow) return unauthorized(request, "invalid_ticket");
		if (Number(trow.expires_at_ms) < now) return unauthorized(request, "expired_ticket");

		const tenantId = String(trow.tenant_id || "");
		const deviceId = String(trow.device_id || "");
		const roleFromToken = "unknown"; // el rol autoritativo se resuelve desde la BD central abajo

		if (!tenantId || !deviceId) {
			return unauthorized(request, "invalid_ticket");
		}

		const fila = await cargarDevice(dbCentral, tenantId, deviceId);
		if (!fila) return unauthorized(request, "device_not_registered");
		if (estaRevocado(fila)) return unauthorized(request, "device_revoked");

		const roleFinal = String(fila.role || roleFromToken || "unknown");
		const pubB64 = String(fila.device_pubkey_b64 || "").trim();

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
app.route("/v1/notificaciones", notificacionesRoutes);
app.route("/v1/proveedores", proveedoresRoutes);
app.route("/v1/reservas", reservasRoutes);
app.route("/v1/stats", statsRoutes);
app.route("/v1/sync", syncRoutes);
app.route("/v1/ws", wsRoutes);
app.route("/v1/tareas", tareasRoutes);
app.route("/v1/trabajadores", trabajadoresRoutes);
app.route("/v1/venta-rapida", ventaRapidaRoutes);
app.route("/v1/email", emailRoutes);

// ---------------- Telemetría (logs de dispositivo → Axiom) ----------------
// Los dispositivos suben aquí sus lotes de logs; el worker los retransmite a Axiom con el token
// privado. Auth device-proof; el tenant/device los fija el servidor (ver telemetry.routes.ts).
app.route("/v1/telemetry", telemetryRoutes);

// ---------------- Licencias ----------------
// Sistema propio: activación, cambio de dispositivo por OTP, estado
// firmado con ed25519 y refresco de token. Lo consume el cliente Rust (tpv-infra-licensing).
app.route("/v1/license", licenseRoutes);

// Emisión: por compra (webhook de Stripe) o a mano (endpoints admin + CLI `pnpm license:*`).
app.route("/v1/stripe", stripeRoutes);
app.route("/v1/admin", adminRoutes);

// ---------------- Auto-actualización de la app de escritorio ----------------
// GET feed (público: lo consume el updater de Tauri, que verifica firma por su cuenta).
// POST publish/deactivate van protegidos por token admin dentro del propio router.
app.route("/v1/update", updatesRoutes);

// ---------------- Gestión de dispositivos ----------------
app.route("/v1/device", dispositivosRoutes);

// Traduce los errores con status (p. ej. HubError del DO: main_offline,
// idempotency_*) a JSON; el resto cae a un 500 con detalle.
app.onError((err, c) => {
	// Reporta a Sentry también los errores que aquí traducimos a JSON: Hono los captura antes de
	// que lleguen al wrapper global de Sentry, así que hay que notificarlos explícitamente.
	Sentry.captureException(err);
	// Traza server-side: sin esto un 500 no deja NINGÚN rastro en `wrangler tail` (el detalle solo
	// viajaba en el cuerpo de la respuesta al cliente), lo que hace imposible diagnosticar en vivo.
	console.error(
		`[onError] ${c.req.method} ${new URL(c.req.url).pathname} → ${(err as any)?.name || "Error"}: ` +
		`${(err as any)?.message || err}\n${(err as any)?.stack || ""}`,
	);
	// El validador del cuerpo (`lib/validacion.ts`) lanza esto cuando el JSON viene roto, con una
	// frase en inglés dentro. Sin esta rama, esa frase viajaría en `error`, que es donde el cliente
	// espera un identificador de máquina: se contesta con el `validation_error` de siempre.
	if (err instanceof HTTPException && err.status === 400) {
		return c.json({ ok: false, code: "validation", error: "validation_error" }, 400);
	}
	const status = (err as any)?.status;
	if (typeof status === "number") {
		return c.json(
			{ error: (err as any)?.code || err.message || "error" },
			status as any,
		);
	}
	const message = String((err as any)?.message || err);
	// Fallos de infraestructura por los que la pantalla de recuperación ofrece una acción distinta.
	// Se clasifican aquí, en la frontera HTTP, para no duplicar catches en cada ruta que usa Turso.
	if (message.includes("tenant_db_not_provisioned")) {
		return c.json(
			{ ok: false, code: "tenant_db_not_provisioned", error: "tenant_db_not_provisioned" },
			404,
		);
	}
	if (message.includes("migration_altered")) {
		return c.json(
			{
				ok: false,
				code: "tenant_migration_altered",
				error: "migration_altered",
				details: { message },
			},
			500,
		);
	}
	return serverError(c.req.raw, "internal_error", {
		message,
	});
});

/**
 * Lo que este worker hace por su cuenta, una vez al día: avisar de las licencias que caducan
 * (REV-13) y recoger la basura de la base central (`server/purga.ts`).
 *
 * Va aquí y no en una ruta porque nadie lo va a llamar: el cliente no sabe que su licencia se
 * acaba hasta que deja de funcionar. El cron está en `wrangler.json` (`triggers.crons`), y los dos
 * cuerpos son idempotentes — un día perdido se recupera solo al siguiente.
 *
 * Cada tarea va en su propio `try` y ninguna propaga: son independientes, y la purga —que es
 * mantenimiento— no puede llevarse por delante un aviso que alguien está esperando para renovar.
 */
async function programado(env: Env): Promise<void> {
	try {
		const r = await avisarDeCaducidades(env, getDb(env));
		console.log(
			`[cron] avisos de caducidad: ${r.enviados} enviados, ${r.yaAvisadas} ya avisadas, ` +
				`${r.fallidos} fallidos, de ${r.revisadas} revisadas`,
		);
	} catch (err) {
		console.error("[cron] avisos de caducidad falló:", (err as any)?.message || err);
	}

	try {
		const r = await purgarBaseCentral(getDb(env));
		console.log(
			`[cron] purga: ${r.fallosDeEmparejamiento} fallos de emparejamiento, ` +
				`${r.trazasDeCorreo} trazas de correo`,
		);
	} catch (err) {
		console.error("[cron] purga falló:", (err as any)?.message || err);
	}
}

// El wrapper de Sentry captura las excepciones no controladas del worker (requiere el flag
// `nodejs_compat`, ver wrangler.json). Si no hay `SENTRY_DSN`, es un no-op transparente.
export default Sentry.withSentry(sentryOptions, {
	fetch: (request, env, ctx) => app.fetch(request, env, ctx),
	scheduled: (_evento, env, ctx) => ctx.waitUntil(programado(env)),
} satisfies ExportedHandler<Env>);
