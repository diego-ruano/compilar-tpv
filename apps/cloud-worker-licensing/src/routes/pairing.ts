// src/routes/pairing.ts
//
// Subrouter Hono del emparejamiento (pairing) Main ↔ Handy.
//
// Es un módulo autocontenido que se monta en el router principal bajo `/v1/pair`
// (ver src/index.ts). Cada ruta delega en el handler ya existente, que conserva
// su lógica/SQL tal cual (sólo cambia el transporte: antes un `if (pathname)` en
// un index gigante, ahora una ruta Hono).
//
// Auth:
//   - `claim`, `fetch-token` y `cancel` son ANÓNIMOS (los usa la Handy antes de tener
//     token): operan sobre la DB central validando código/secreto/firma.
//   - `create`, `pending`, `approve` y `reject` son de la MAIN/TPV: el handler verifica el
//     JWT + el "device proof" ed25519 internamente vía `buildTenantContext`
//     (ver server/middleware/withTenant.ts).
//
// NOTA sobre tipos (@tpv/contracts): el emparejamiento NO tiene DTOs generados
// desde Rust porque el cliente de la TPV no llama a estos endpoints con structs
// tipadas, sino a través del passthrough genérico `tpv_server_post_json`. Por eso
// las formas de request/response de pairing se mantienen como en el código
// original (sin contraparte en `bindings.ts`). Los endpoints de negocio que se
// migren más adelante SÍ importarán sus tipos de `@tpv/contracts`.

import { Hono } from "hono";

import type { Env } from "../env";
import { getDb } from "../server/db";

import { handlePairClaim } from "../server/endpoints/rest/pairing/pairClaim";
import { handlePairFetchToken } from "../server/endpoints/rest/pairing/pairFetchToken";
import { handlePairCreate } from "../server/endpoints/rest/pairing/pairCreate";
import { handlePairPending } from "../server/endpoints/rest/pairing/pairPending";
import { handlePairApprove } from "../server/endpoints/rest/pairing/pairApprove";
import { handlePairCancel } from "../server/endpoints/rest/pairing/pairCancel";
import { handlePairReject } from "../server/endpoints/rest/pairing/pairReject";
import { ensurePairingSchema } from "../server/endpoints/rest/pairing/pairing.esquema";

export const pairingRoutes = new Hono<{ Bindings: Env }>();

// Las tablas del emparejamiento, antes de cualquier ruta (una vez por isolate).
pairingRoutes.use("*", async (c, next) => {
	await ensurePairingSchema(getDb(c.env));
	await next();
});

// ---- Handy (anónimos, firmados por el dispositivo que reclamó) ----
pairingRoutes.post("/claim", (c) =>
	handlePairClaim(c.req.raw, c.env, getDb(c.env)),
);

pairingRoutes.post("/fetch-token", (c) =>
	handlePairFetchToken(c.req.raw, c.env, getDb(c.env)),
);

pairingRoutes.post("/cancel", (c) =>
	handlePairCancel(c.req.raw, c.env, getDb(c.env)),
);

// ---- Main / TPV (autenticados: token + device proof dentro del handler) ----
pairingRoutes.post("/create", (c) =>
	handlePairCreate(c.req.raw, c.env, getDb(c.env)),
);

pairingRoutes.post("/pending", (c) =>
	handlePairPending(c.req.raw, c.env, getDb(c.env)),
);

pairingRoutes.post("/approve", (c) =>
	handlePairApprove(c.req.raw, c.env, getDb(c.env)),
);

pairingRoutes.post("/reject", (c) =>
	handlePairReject(c.req.raw, c.env, getDb(c.env)),
);
