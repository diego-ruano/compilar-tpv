// src/env.ts
//
// Env unificado del worker `tpv-api` (antes `tpv-licensing`).
//
// Tras fusionar los dos workers, este único worker concentra:
//   - La base de datos central de Turso (`TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`).
//   - Los secretos de licencias (`LICENSE_JWT_SECRET`, `LICENSE_STORE_KEY`,
//     `LICENSE_SIGNING_PRIVATE_KEY`, `ADMIN_API_TOKEN`, `STRIPE_*`).
//   - El Turso Platform API (`TURSO_PLATFORM_TOKEN`, `TURSO_ORG_SLUG`) para
//     aprovisionar/rotar las DBs por-tenant.
//   - El Durable Object `TenantHub` (WebSocket + apply idempotente).
//   - El pepper de emparejamiento (`PAIR_PEPPER`) y el TTL opcional del token Handy.
//
// Ya NO existe el service binding `TPV_LICENSING`: la resolución de la DB del
// tenant es ahora una llamada de función local (ver server/db/tenantDb.ts).

export interface Env {
	// Turso central (DB de control: tenants, devices, licencias, pair_requests…)
	TURSO_DATABASE_URL: string;
	TURSO_AUTH_TOKEN: string;

	// Licencias / firma de tokens
	LICENSE_JWT_SECRET: string;
	LICENSE_STORE_KEY: string; // base64 32 bytes (AES-GCM): cifra la clave de licencia en reposo

	// Firma ed25519 del estado de licencia (§5.1 del plan de licencias propias).
	// Semilla de 32 bytes en base64. La PRIVADA vive SOLO aquí; la pública está pineada como
	// constante en el binario Rust (LICENSE_SIGNING_PUBLIC_KEY_B64). Cambiarla invalida a todos
	// los clientes desplegados. Configura con: wrangler secret put LICENSE_SIGNING_PRIVATE_KEY
	LICENSE_SIGNING_PRIVATE_KEY: string;

	// Token del endpoint admin de licencias (/v1/admin/*): emitir, listar, revocar, extender.
	// ≥ 256 bits, comparación timing-safe. Si NO está configurado, el dominio admin queda
	// DESHABILITADO (fail-closed). Configura con: wrangler secret put ADMIN_API_TOKEN
	ADMIN_API_TOKEN?: string;

	// Stripe (pago único: 1/3/12 meses). La duración de cada compra se lee de
	// `metadata.term_months` del Price, no de un mapa en el código.
	//   wrangler secret put STRIPE_SECRET_KEY      (sk_live_… / sk_test_…)
	//   wrangler secret put STRIPE_WEBHOOK_SECRET  (whsec_…)
	STRIPE_SECRET_KEY?: string;
	STRIPE_WEBHOOK_SECRET?: string;

	// URL pública donde el cliente compra/renueva (la usan los emails de aviso de caducidad).
	CHECKOUT_URL?: string;

	// Turso Platform API (crear DBs + tokens por-tenant)
	TURSO_PLATFORM_TOKEN: string;
	TURSO_ORG_SLUG: string;

	// Emparejamiento Handy
	PAIR_PEPPER?: string;
	HANDY_TOKEN_TTL_SECONDS?: string | number;

	// Durable Object (WebSocket hub por tenant)
	TenantHub: DurableObjectNamespace;

	// Bucket R2 de imágenes (productos/categorías/proveedores/alérgenos).
	// Las claves replican la ruta de la Main: `{tenantId}/images/{subcarpeta}/{uuid}.jpg`.
	// Las LECTURAS (GET) se sirven públicas + Cache API (CDN edge); las ESCRITURAS
	// (PUT/DELETE) van firmadas (JWT + device-proof) y derivan el token.
	IMAGES: R2Bucket;

	// Cloudflare Email Service: binding de envío de correo (send_email en wrangler.json).
	// No lleva claves: el binding autentica solo. El dominio del remitente debe estar dado de
	// alta en Email Sending (SPF+DKIM) — ver `wrangler email sending enable <dominio>`.
	EMAIL: SendEmail;

	// Remitente de los correos gestionados. El dominio de EMAIL_FROM_ADDRESS debe estar onboarded
	// en Email Sending. Ejemplos: EMAIL_FROM_ADDRESS="pedidos@altarialights.com", EMAIL_FROM_NAME="TPV".
	EMAIL_FROM_ADDRESS: string;
	EMAIL_FROM_NAME?: string;

	// Token admin para publicar/retirar releases del feed de auto-actualización
	// (POST /v1/update/publish y /deactivate). Si NO está configurado, la publicación
	// queda deshabilitada (fail-safe). Configura con: wrangler secret put RELEASE_ADMIN_TOKEN
	RELEASE_ADMIN_TOKEN?: string;

	// ── Observabilidad ──
	// Sentry (errores). DSN del proyecto del worker. Si NO está, Sentry queda deshabilitado
	// (no-op): el código es seguro de desplegar antes de crear el proyecto.
	// Configura con: wrangler secret put SENTRY_DSN
	SENTRY_DSN?: string;
	// Entorno para separar métricas (dev/staging/prod). Por defecto "prod".
	ENVIRONMENT?: string;
	// Release opcional (p. ej. versión desplegada) para agrupar regresiones en Sentry.
	SENTRY_RELEASE?: string;

	// Axiom (logs estructurados). El token es PRIVADO y vive sólo aquí (nunca en el dispositivo).
	// Si falta, el reenvío a Axiom se omite silenciosamente. Configura con:
	//   wrangler secret put AXIOM_TOKEN
	AXIOM_TOKEN?: string;
	// Dataset de Axiom donde caen los logs reenviados desde los dispositivos.
	AXIOM_DATASET?: string;
	// Dataset de Axiom para los eventos de salud del sistema de sincronización (TenantHub).
	AXIOM_DATASET_SYNC?: string;
}
