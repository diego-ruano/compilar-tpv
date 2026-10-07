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

	// Firma ed25519 del estado de licencia (docs/arquitectura/licencias.md).
	// Semilla de 32 bytes en base64. La PRIVADA vive SOLO aquí; su pública está pineada en el binario
	// Rust (LICENSE_SIGNING_PUBLIC_KEYS_B64) junto a la de reserva, cuya privada se guarda fuera de
	// línea (RI-09). Una privada cuya pública no esté en esa lista deja a todos los equipos en
	// `bad_signature`. Configura con: wrangler secret put LICENSE_SIGNING_PRIVATE_KEY
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

	// REV-13 · El enlace público donde el cliente compra. Uno solo, y sirve para las dos cosas:
	// si teclea la clave en un equipo que ya tiene licencia, se le suma el tiempo; si no, estrena.
	// Lo decide `licensing.routes.ts` al activar, no el enlace por el que se compró — que es lo
	// que hace que nadie pueda equivocarse comprando.
	//
	// Lo usa el correo de aviso de caducidad. Sin esta variable no se manda ningún aviso: uno que
	// no lleva a ninguna parte es peor que no mandarlo.
	CHECKOUT_URL?: string;

	// Turso Platform API (crear DBs + tokens por-tenant)
	TURSO_PLATFORM_TOKEN: string;
	TURSO_ORG_SLUG: string;

	// Emparejamiento Handy
	PAIR_PEPPER?: string;
	HANDY_TOKEN_TTL_SECONDS?: string | number;

	// Filtro exterior del claim de emparejamiento (`pairing.intentos.ts`). Declarado en
	// `wrangler.json` (`ratelimits`), no es un recurso que haya que crear en Cloudflare.
	// OPCIONAL a propósito: sin él la espera escalonada sigue funcionando igual, sólo se pagan
	// las lecturas de Turso que este filtro ahorra.
	LIMITADOR_CLAIM?: RateLimit;

	// RI-68 · Filtro por IP de `/v1/license/activate` y `/v1/license/device-change/request`
	// (`licensing.routes.ts`). Igual que el anterior: opcional, y detrás están los topes exactos por
	// licencia del código de cambio de equipo.
	LIMITADOR_LICENCIA?: RateLimit;

	// Durable Object (WebSocket hub por tenant)
	TenantHub: DurableObjectNamespace;

	// Bucket R2 de imágenes (productos/categorías/proveedores/alérgenos).
	// Las claves replican la ruta de la Main: `{tenantId}/images/{subcarpeta}/{uuid}.jpg`.
	// Las LECTURAS (GET) se sirven públicas + Cache API (CDN edge); las ESCRITURAS
	// (PUT/DELETE) van firmadas (JWT + device-proof) y derivan el token.
	IMAGES: R2Bucket;

	// PROD-02 · Bucket PRIVADO de las copias diarias de la base central (`server/copiaBaseCentral.ts`).
	// No puede ser el de imágenes: aquél es público por `r2.dev`, y esto lleva correos de clientes y
	// las DEK cifradas. Cuánto duran las copias lo fija su regla de ciclo de vida, en Cloudflare.
	COPIAS: R2Bucket;

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
	// Dominio del EDGE DEPLOYMENT de Axiom (no `api.axiom.co`, que es el endpoint legacy y manda
	// los datos a US East 1). El nuestro es `eu-central-1.aws.edge.axiom.co`. Se ve en
	// Axiom → Settings → General → Edge deployment.
	AXIOM_DOMAIN?: string;

	// Better Stack (PROD-01). URL del heartbeat que pulsa el cron diario al terminar. Si falta, no
	// se late y no pasa nada más: esto se puede desplegar antes de crear el heartbeat.
	// Es un SECRETO y no una var de `wrangler.json` —ese fichero está en git— porque quien tenga
	// esta URL puede silenciar la alarma. Configura con:
	//   wrangler secret put BETTERSTACK_HEARTBEAT_URL
	BETTERSTACK_HEARTBEAT_URL?: string;
	// PROD-02 · El heartbeat de la copia de la base central. Distinto del anterior a propósito: aquél
	// late aunque las tareas fallen («¿se ejecuta el cron?») y éste SÓLO si la copia se subió bien
	// («¿hay una copia de hoy?»). Con uno solo, el cron seguiría en verde con las copias rotas.
	//   wrangler secret put BETTERSTACK_HEARTBEAT_COPIAS_URL
	BETTERSTACK_HEARTBEAT_COPIAS_URL?: string;
}
