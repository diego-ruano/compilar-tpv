import type { AgendaWeb } from "./durableObjects/agendaWeb";
import type { BaseCentral } from "./durableObjects/baseCentral";
import type { TenantHub } from "./durableObjects/tenantHub";
// src/env.ts
//
// Env unificado del worker `tpv-api` (antes `tpv-licensing`).
//
// Tras fusionar los dos workers, este único worker concentra:
//   - La base central (licencias, negocios, dispositivos, emparejamientos…), en su Durable Object
//     `BaseCentral`.
//   - Los secretos de licencias (`LICENSE_JWT_SECRET`, `LICENSE_STORE_KEY`,
//     `LICENSE_SIGNING_PRIVATE_KEY`, `ADMIN_API_TOKEN`, `STRIPE_*`).
//   - El Durable Object `TenantHub` (WebSocket + apply idempotente), que guarda además la base de
//     cada negocio en su SQLite.
//   - El pepper de emparejamiento (`PAIR_PEPPER`) y el TTL opcional del token Handy.

export interface Env {
	// Licencias / firma de tokens
	LICENSE_JWT_SECRET: string;
	LICENSE_STORE_KEY: string; // base64 32 bytes (AES-GCM): cifra en reposo las claves y las DEK
	// RI-73 · La versión de `LICENSE_STORE_KEY` (por defecto "1") y, durante una rotación, la clave
	// anterior con la suya (`server/crypto.ts`). Las dos últimas sólo existen mientras dura la rotación.
	LICENSE_STORE_KEY_ID?: string;
	LICENSE_STORE_KEY_ANTERIOR?: string;
	LICENSE_STORE_KEY_ANTERIOR_ID?: string;

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

	// Emparejamiento Handy
	PAIR_PEPPER?: string;
	HANDY_TOKEN_TTL_SECONDS?: string | number;

	// Filtro exterior del claim de emparejamiento (`pairing.intentos.ts`). Declarado en
	// `wrangler.json` (`ratelimits`), no es un recurso que haya que crear en Cloudflare.
	// OPCIONAL a propósito: sin él la espera escalonada sigue funcionando igual, sólo se pagan
	// las lecturas de la base central que este filtro ahorra.
	LIMITADOR_CLAIM?: RateLimit;

	// RI-68 · Filtro por IP de `/v1/license/activate` y `/v1/license/device-change/request`
	// (`licensing.routes.ts`). Igual que el anterior: opcional, y detrás están los topes exactos por
	// licencia del código de cambio de equipo.
	LIMITADOR_LICENCIA?: RateLimit;

	// Reservas desde la web (docs/estudios/reservas-web.md): filtros por IP de las rutas públicas
	// (`domains/reservas_web/puerta.ts`), uno para las lecturas y otro, mucho más estrecho, para el
	// alta. Opcionales como los de arriba: detrás están los topes exactos de la agenda.
	LIMITADOR_RESERVA_WEB?: RateLimit;
	LIMITADOR_RESERVA_WEB_ALTA?: RateLimit;

	// INFRA-03 · Filtro por IP del GET público de imágenes (`domains/images/images.routes.ts`), que
	// pinta la Handy. Holgado: una Handy que estrena la carta pide cientos de golpe. Opcional como los
	// de arriba: sin él cada imagen sigue saliendo de R2, sólo que sin techo por red.
	LIMITADOR_IMAGENES?: RateLimit;
	// Turnstile del widget. La clave pública va en `vars`; el secreto, con
	// `wrangler secret put TURNSTILE_SECRET_KEY`. Sin secreto el alta queda cerrada (503).
	TURNSTILE_SITE_KEY?: string;
	TURNSTILE_SECRET_KEY?: string;
	// La dirección pública del widget: la que lleva la línea que se pega en la web y los enlaces de los
	// correos, venga la petición por donde venga. Hoy es la de `workers.dev`, la misma de la API: los
	// nombres propios de `altarialights.com` salen por IP que se bloquean con el fútbol (INFRA-04).
	// Vacía, la de la propia petición: así funciona `wrangler dev`.
	RESERVAS_WEB_ORIGEN?: string;

	// El widget de reservas web compilado (`apps/reservas-web/dist`), en Workers Static Assets. Pasa
	// todo por el worker (`run_worker_first`): `domains/reservas_web/widget.routes.ts` le pone a cada
	// fichero su caché y al widget su CSP.
	ASSETS: Fetcher;

	// Durable Object por negocio: su WebSocket hub y su base, en el SQLite del propio objeto.
	TenantHub: DurableObjectNamespace<TenantHub>;

	// La agenda de reservas web, una por negocio (docs/estudios/reservas-web.md §4.3). Nunca escribe
	// en la base del negocio: guarda en su SQLite lo que espera a la Main.
	AgendaWeb: DurableObjectNamespace<AgendaWeb>;

	// La base central en su Durable Object, uno solo para todo el servicio (`durableObjects/baseCentral.ts`).
	// Se pide sólo con `centralDe` (`lib/objetosDelNegocio.ts`), que fija su nombre y su sitio.
	BaseCentral: DurableObjectNamespace<BaseCentral>;

	// Dónde nacen los dos DO de un negocio, que guardan sus datos (`lib/objetosDelNegocio.ts`).
	// Jurisdicción: vacía, que es ninguna (decisión del responsable, por latencia). El mismo nombre da
	// otro objeto en otra jurisdicción: cambiarla es empezar de cero.
	JURISDICCION_DO?: string;
	// Pista de región para el objeto de un negocio nuevo: «weur», Europa occidental. Sólo cuenta en
	// la llamada que lo crea, venga de donde venga. Vacía en local y en los tests.
	UBICACION_DO?: string;

	// Bucket R2 de imágenes (productos/categorías/proveedores/alérgenos).
	// Las claves replican la ruta de la Main: `{tenantId}/images/{subcarpeta}/{uuid}.jpg`.
	// La app lo lee por el worker: el GET público de `/v1/images/{tenant}/…` (la Handy) y el POST
	// firmado de `/download` (la Main); las ESCRITURAS (PUT/DELETE) van firmadas (JWT +
	// device-proof) y el negocio sale del token. INFRA-03: su dirección pública `r2.dev` está
	// cerrada; sólo se lee por el worker.
	//
	// Guarda también el PDF de cada factura completa, en `{tenantId}/facturas/{ID_Registro}.pdf`: un
	// solo bucket para lo de los TPV, por decisión del responsable. Esa carpeta sólo se sube y se baja
	// por `/v1/facturas` (firmado, sólo la Main vigente), nunca se sobrescribe ni se borra, y ninguna
	// ruta de `/v1/images` —tampoco el GET público— la entrega, la acepta ni la borra
	// (`domains/facturas/`, `test/facturasEnElBucket.test.ts`).
	IMAGES: R2Bucket;

	// PROD-02 · Bucket PRIVADO de las copias diarias de la base central (`durableObjects/baseCentral.copia.ts`).
	// No puede ser el de imágenes: aquél se sirve sin firma por `/v1/images`, y esto lleva correos de clientes y
	// las DEK cifradas. Cuánto duran las copias lo fija su regla de ciclo de vida, en Cloudflare.
	COPIAS: R2Bucket;

	// DO-03 · Bucket PRIVADO de las copias diarias de la base de cada negocio
	// (`durableObjects/tenantHub.copia.ts`): `negocios/<negocio>/<día>.sql.gz`. Lleva datos personales
	// (clientes, personal, reservas). No es el de la base central: otro token de R2 puede leer aquél
	// sin leer éste, y aquí cuántas se guardan lo decide el código, no una regla de ciclo de vida.
	COPIAS_NEGOCIOS: R2Bucket;

	// Cloudflare Email Service: binding de envío de correo (send_email en wrangler.json).
	// No lleva claves: el binding autentica solo. El dominio del remitente debe estar dado de
	// alta en Email Sending (SPF+DKIM) — ver `wrangler email sending enable <dominio>`.
	EMAIL: SendEmail;

	// Remitente de los correos gestionados. El dominio de EMAIL_FROM_ADDRESS debe estar onboarded
	// en Email Sending. Ejemplos: EMAIL_FROM_ADDRESS="pedidos@altarialights.com", EMAIL_FROM_NAME="TPV".
	EMAIL_FROM_ADDRESS: string;
	EMAIL_FROM_NAME?: string;
	// Remitente de los correos de las reservas web (`domains/reservas_web/correos.ts`), con el nombre
	// del negocio. Mismo dominio que el de los pedidos.
	EMAIL_RESERVAS_FROM_ADDRESS?: string;

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
	BUILD_COMMIT?: string;

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
