// src/app.ts
//
// La API de `tpv-api` (Hono): todas las rutas, con sus middlewares globales y el `onError`.
//
// Vive aparte de `index.ts` porque la ejecutan dos sitios: el Worker, que la sirve, y el TenantHub de
// cada negocio, que ejecuta dentro las rutas de negocio para que cada petición cueste un solo viaje
// a su base (`lib/enElHub.ts`). `index.ts` la envuelve con Sentry y le añade el cron.
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

import type { Env } from "./env";
import { capturarError } from "./observability/errors";
import { registrarPeticion } from "./observability/requestContext";
import { cabeceraServerTiming, conMedida } from "./observability/tiempos";
import { getDb } from "./server/db";
import { comprobarSalud } from "./server/salud";
import { hubDe } from "./lib/hub";
import { cuerpoDeErrorConStatus } from "./lib/errorHttp";
import {
	json,
	unauthorized,
	serverError,
	corsHeaders,
} from "./server/utils/response";

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
import { reservasWebMainRoutes } from "./domains/reservas_web/main.routes";
import { reservasWebPublicoRoutes } from "./domains/reservas_web/publico.routes";
import { preflightPublico } from "./domains/reservas_web/cors";
import { reservasWebWidgetRoutes } from "./domains/reservas_web/widget.routes";
import { statsRoutes } from "./domains/stats/stats.routes";
import { syncRoutes } from "./domains/sync/sync.routes";
import { wsRoutes } from "./domains/ws/ws.routes";
import { CABECERAS_DE_IDENTIDAD, canjearTicket } from "./domains/ws/canje";
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
import { interruptoresRoutes } from "./domains/interruptores/interruptores.routes";
import { completarErrores } from "./middleware/completarErrores";
import { esDispositivoAutenticado } from "./middleware/tenant";

export const app = new Hono<{ Bindings: Env }>();

// El desglose del tiempo de cada petición (`observability/tiempos.ts`), que lee el generador de carga.
// Sólo se le enseña a un dispositivo de un negocio, ya autenticado (`tenantAuth`): una ruta pública
// o anónima (el widget de las reservas, `/health`, las actualizaciones, el emparejamiento, las
// licencias) no cuenta cuánto tardan la base central y el TenantHub ni en qué centro de datos se la
// atiende. Va antes que nada para que el total lo cubra todo; el upgrade del WebSocket (101) no se toca.
app.use("*", async (c, next) => {
	const { medida } = await conMedida(() => next());
	if (c.res.status === 101 || !esDispositivoAutenticado(c)) return;
	const valor = cabeceraServerTiming(medida, (c.req.raw.cf as { colo?: string } | undefined)?.colo);
	try {
		c.res.headers.set("Server-Timing", valor);
	} catch {
		// Una respuesta que llega de otro sitio (un `fetch`) tiene las cabeceras inmutables.
		c.res = new Response(c.res.body, c.res);
		c.res.headers.set("Server-Timing", valor);
	}
});

// Todas las respuestas de error salen con `code` y, si lo hay, `message` legible. Va el primero
// para envolver también las que produce `onError`.
app.use("*", completarErrores);
app.use("*", async (c, next) => {
	registrarPeticion(c);
	await next();
});

// ---------------- CORS preflight ----------------
// Las rutas públicas de la reserva web tienen el suyo: las webs de cada negocio (`cors.ts`). Va
// delante: el de abajo contesta a todo y no deja pasar a ningún router.
app.options("/v1/publico/reservas/:clave/*", preflightPublico);
app.options("*", (c) =>
	new Response(null, { status: 204, headers: corsHeaders(c.req.raw) }),
);

// ---------------- Health ----------------
//
// PROD-01 · Lo que sondea la monitorizacion externa. Toca la base central a proposito: un
// `{ ok: true }` que no comprueba nada deja el monitor en verde durante la averia entera, que es
// justo el silencio que esto existe para romper. El porque largo, en `server/salud.ts`.
app.get("/health", async (c) => {
	// RI-73: también descifra el canario de `LICENSE_STORE_KEY` (ver `server/salud.ts`).
	const claves = c.env.LICENSE_STORE_KEY ? c.env : undefined;
	const salud = await comprobarSalud(() => getDb(c.env), Date.now(), claves);
	return json(
		{ ok: salud.ok, service: "tpv-api", db: salud.db, cifrado: salud.cifrado, ts: Date.now() },
		salud.ok ? 200 : 503,
		c.req.raw,
	);
});

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

		// Un viaje a la base central: el canje, la fila del dispositivo y su `last_seen`, en un lote
		// (`domains/ws/canje.ts`). El TenantHub se fía de lo que le pasan estas cabeceras y no vuelve a
		// ella.
		const canje = await canjearTicket(dbCentral, ticketQ, Date.now());
		if (!canje.ok) return unauthorized(request, canje.error);

		const stub = hubDe(env, canje.tenantId);

		const doUrl = new URL(request.url);
		doUrl.pathname = "/ws";

		// Las cabeceras de identidad las pone sólo el Worker: las que traiga el cliente se quitan antes,
		// también la clave pública, que el TenantHub usa para verificar el saludo.
		const h = new Headers(request.headers);
		for (const nombre of CABECERAS_DE_IDENTIDAD) h.delete(nombre);
		h.set("x-tenant-id", canje.tenantId);
		h.set("x-device-id", canje.deviceId);
		h.set("x-role", canje.rol);
		h.set("x-device-pubkey-b64", canje.clave);

		return await stub.fetch(new Request(doUrl.toString(), new Request(request, { headers: h })));
	} catch (e: any) {
		capturarError(e, "websocket.open");
		// FABLE-B: la traza se queda aquí (`wrangler tail`) y en Sentry; la respuesta no la lleva.
		console.error(
			`[ws] no se pudo abrir el WebSocket → ${e?.name || "Error"}: ${e?.message || e}\n${e?.stack || ""}`,
		);
		return serverError(request, "internal_error");
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
// Reservas desde la web (docs/estudios/reservas-web.md): lo que pide la Main.
app.route("/v1/reservas-web", reservasWebMainRoutes);
// Y lo que llama el widget, sin dispositivo ni token: la puerta va por la clave del negocio.
app.route("/v1/publico/reservas", reservasWebPublicoRoutes);
// Y el widget, que se incrusta en la web del restaurante (lo compilado de apps/reservas-web).
app.route("/reservas-web", reservasWebWidgetRoutes);
app.route("/v1/stats", statsRoutes);
app.route("/v1/sync", syncRoutes);
app.route("/v1/ws", wsRoutes);
app.route("/v1/tareas", tareasRoutes);
app.route("/v1/trabajadores", trabajadoresRoutes);
app.route("/v1/venta-rapida", ventaRapidaRoutes);
app.route("/v1/email", emailRoutes);

// ---------------- Interruptores remotos de emergencia (PROD-06) ----------------
// Lo que el TPV tiene apagado ahora. Se apagan y encienden por `/v1/admin/interruptores`.
app.route("/v1/interruptores", interruptoresRoutes);

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
// idempotency_*) a JSON; el resto cae a un 500 sin detalle (FABLE-B).
app.onError((err, c) => {
	// Reporta a Sentry también los errores que aquí traducimos a JSON: Hono los captura antes de
	// que lleguen al wrapper global de Sentry, así que hay que notificarlos explícitamente.
	capturarError(err, `${c.req.method} ${c.req.routePath}`);
	// Traza server-side: es el único sitio, junto con Sentry, donde queda el detalle de un 500. La
	// respuesta no lo lleva (FABLE-B), así que sin esto no habría forma de diagnosticarlo en vivo.
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
		// ARQ-07: el error ya llega clasificado; no se vuelve a deducir mirando su prosa.
		return c.json(cuerpoDeErrorConStatus(err), status as any);
	}
	return serverError(c.req.raw, "internal_error");
});
