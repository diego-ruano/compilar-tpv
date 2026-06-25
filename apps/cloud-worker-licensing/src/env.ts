// src/env.ts
//
// Env unificado del worker `tpv-api` (antes `tpv-licensing`).
//
// Tras fusionar los dos workers, este único worker concentra:
//   - La base de datos central de Turso (`TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`).
//   - Los secretos de licencias/JWT (`LICENSE_JWT_SECRET`, `LICENSE_STORE_KEY`,
//     `LEMON_WEBHOOK_SECRET`).
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
	LICENSE_STORE_KEY: string; // base64 32 bytes (AES-GCM)
	LEMON_WEBHOOK_SECRET: string;

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

	// Resend API key para envío de correos gestionados (modo "nuestro servicio").
	// Configura con: wrangler secret put RESEND_API_KEY
	RESEND_API_KEY: string;

	// Dirección de origen para correos gestionados (dominio verificado en Resend).
	// Ejemplo: "TPV <pedidos@altarialights.com>"
	RESEND_FROM_ADDRESS: string;

	// Token admin para publicar/retirar releases del feed de auto-actualización
	// (POST /v1/update/publish y /deactivate). Si NO está configurado, la publicación
	// queda deshabilitada (fail-safe). Configura con: wrangler secret put RELEASE_ADMIN_TOKEN
	RELEASE_ADMIN_TOKEN?: string;
}
