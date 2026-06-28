// src/domains/licensing/licensing.routes.ts
//
// Rutas de licencias migradas a Hono (antes en el handler legacy `server/index.ts`, servido por el
// fallthrough `app.all("*")`). Tres endpoints:
//   - POST /v1/license/activate  → activación contra Lemon + provisión de la BD del tenant.
//   - GET  /v1/license/status    → estado de la licencia (requiere JWT + device-proof).
//   - POST /v1/webhooks/lemon     → webhook de Lemon Squeezy (idempotente por firma+body).
//
// La lógica es la misma que la del handler legacy; sólo cambia el envoltorio (fetch manual → Hono)
// y se reutilizan las utilidades compartidas del worker (ver licensing.helpers.ts).

import { Hono } from "hono";

import type { Env } from "../../env";
import type {
	ActivateRequest,
	ActivateResponse,
	ApiError,
	LemonWebhookPayload,
	LicenseStatus,
} from "../../shared";
import { getDb } from "../../server/db";
import { sha256Hex } from "../../server/crypto";
import {
	ensureExtraSchema,
	ensureTenantExistsMinimal,
	ensureDevice,
	upsertLicenseFromEventOrActivation,
	upsertLicenseInstance,
	getLicenseByHash,
	upsertWebhookEvent,
	markWebhookProcessed,
	setDevicePubKeyB64IfEmptyOrThrow,
} from "../../server/licenseStore";
import {
	assertEnv,
	lemonActivate,
	provisionTenantDatabase,
	signToken,
	toBool01,
	verifyDeviceProof,
	verifyLemonSignature,
	verifyToken,
} from "./licensing.helpers";

type Ctx = { Bindings: Env };

// ──────────────────────────────────────────────────────────────────────────────
// /v1/license  (activate + status)
// ──────────────────────────────────────────────────────────────────────────────

export const licenseRoutes = new Hono<Ctx>();

// POST /v1/license/activate  (TPV MAIN)
licenseRoutes.post("/activate", async (c) => {
	const env = c.env;
	const miss = assertEnv(env, [
		"LICENSE_JWT_SECRET",
		"LICENSE_STORE_KEY",
		"TURSO_DATABASE_URL",
		"TURSO_AUTH_TOKEN",
		"TURSO_PLATFORM_TOKEN",
		"TURSO_ORG_SLUG",
	]);
	if (miss) return c.json({ ok: false, error: miss }, 500);

	const ct = c.req.header("content-type") || "";
	if (!ct.toLowerCase().includes("application/json")) {
		return c.json({ ok: false, error: "Content-Type must be application/json" }, 415);
	}

	const body = await c.req.json<ActivateRequest & { devicePubKey?: string }>().catch(
		() => ({ activationKey: "", deviceId: "", instanceName: undefined }) as any,
	);

	const activationKey = String((body as any).activationKey || "").trim();

	// deviceId: si viene, lo respetamos; si no, lo genera el Worker.
	const reqDeviceId = String((body as any).deviceId || "").trim();
	const deviceId = reqDeviceId || crypto.randomUUID();

	// devicePubKey (obligatoria para anti-copia).
	const devicePubKey = String((body as any).devicePubKey || "").trim();
	if (!devicePubKey) return c.json({ ok: false, error: "devicePubKey required" }, 400);

	// instanceName: si no viene, lo generamos a partir del deviceId.
	const reqInstanceName = String((body as any).instanceName || "").trim();
	const instanceName = reqInstanceName || `tpv-${deviceId.slice(0, 12)}`;

	if (!activationKey) {
		const out: ApiError = { ok: false, error: "activationKey required" };
		return c.json(out, 400);
	}

	const dbi = getDb(env);
	await ensureExtraSchema(dbi);

	// Idempotencia antes de tocar Lemon.
	const licHash = await sha256Hex(activationKey);
	const existing = await getLicenseByHash(dbi, licHash);

	let act: { ok: boolean; status: number; data: any; text: string };

	if (!existing || !existing.tenant_id || existing.tenant_id === "PENDING") {
		act = await lemonActivate(activationKey, instanceName);
		if (!act.ok) {
			const out: ApiError = {
				ok: false,
				error: act.data?.error || "lemon_activate_failed",
				details: act.data || act.text,
			};
			return c.json(out, 400);
		}
	} else {
		act = {
			ok: true,
			status: 200,
			data: {
				license_key: { status: existing.status, expires_at: existing.expires_at },
				meta: { reused: true },
			},
			text: "",
		};
	}

	const licenseKeyObj = act.data?.license_key;
	const instanceObj = act.data?.instance;

	const status = (licenseKeyObj?.status || "active") as LicenseStatus;
	const expiresAt = licenseKeyObj?.expires_at ? String(licenseKeyObj.expires_at) : null;
	const instanceId = instanceObj?.id ? String(instanceObj.id) : null;

	const tenantId =
		existing?.tenant_id && existing.tenant_id !== "PENDING"
			? existing.tenant_id
			: crypto.randomUUID();

	// Garantiza tenant y device.
	await ensureTenantExistsMinimal(dbi, tenantId);

	// ensureDevice también guarda pubkey si procede (y controla mismatch).
	await ensureDevice(dbi, tenantId, deviceId, "tpv", devicePubKey);

	// Extra seguridad: si ya existía key distinta, esto lanza 409.
	await setDevicePubKeyB64IfEmptyOrThrow(dbi, tenantId, deviceId, devicePubKey);

	const { license } = await upsertLicenseFromEventOrActivation({
		db: dbi,
		storeKeyB64: env.LICENSE_STORE_KEY,
		licenseKeyPlain: activationKey,
		tenantId,
		status,
		expiresAt,
		testMode: Boolean(act.data?.meta?.test_mode),

		lemon_license_key_id: licenseKeyObj?.id
			? String(licenseKeyObj.id)
			: existing?.lemon_license_key_id ?? null,
		lemon_customer_id: licenseKeyObj?.customer_id ? String(licenseKeyObj.customer_id) : null,
		lemon_order_id: licenseKeyObj?.order_id ? String(licenseKeyObj.order_id) : null,
		lemon_order_item_id: licenseKeyObj?.order_item_id
			? String(licenseKeyObj.order_item_id)
			: null,
		lemon_store_id: licenseKeyObj?.store_id ? String(licenseKeyObj.store_id) : null,
		lemon_product_id: licenseKeyObj?.product_id ? String(licenseKeyObj.product_id) : null,

		instances_count:
			typeof licenseKeyObj?.instances_count === "number"
				? licenseKeyObj.instances_count
				: null,
		activation_limit:
			typeof licenseKeyObj?.activation_limit === "number"
				? licenseKeyObj.activation_limit
				: null,

		user_name: licenseKeyObj?.user_name ? String(licenseKeyObj.user_name) : null,
		user_email: licenseKeyObj?.user_email ? String(licenseKeyObj.user_email) : null,

		lemon_created_at: licenseKeyObj?.created_at ? String(licenseKeyObj.created_at) : null,
		lemon_updated_at: licenseKeyObj?.updated_at ? String(licenseKeyObj.updated_at) : null,

		meta: act.data?.meta || null,
	});

	if (instanceId) {
		await upsertLicenseInstance(dbi, {
			instanceId,
			licenseId: license.license_id,
			tenantId,
			deviceId,
			instanceName: instanceName || null,
		});
	}

	// Provisión de la BD del tenant + esquema + admin inicial.
	try {
		await provisionTenantDatabase(dbi, env, tenantId);
	} catch (e: any) {
		return c.json(
			{ ok: false, error: "tenant_db_provision_failed", details: String(e?.message || e) },
			500,
		);
	}

	const token = await signToken(env, { tenantId, deviceId, licHash });

	const out: ActivateResponse & { deviceId: string } = {
		ok: true,
		tenantId,
		deviceId,
		token,
		status,
		expiresAt,
	};

	return c.json(out);
});

// GET /v1/license/status
licenseRoutes.get("/status", async (c) => {
	const env = c.env;
	const miss = assertEnv(env, ["LICENSE_JWT_SECRET", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"]);
	if (miss) return c.json({ ok: false, error: miss }, 500);

	const h = c.req.header("authorization") || "";
	const m = h.match(/^Bearer\s+(.+)$/i);
	if (!m) return c.json({ ok: false, error: "missing_token" }, 401);

	let claims: { tenantId: string; deviceId: string; licHash: string };
	try {
		claims = await verifyToken(env, m[1]);
	} catch {
		return c.json({ ok: false, error: "invalid_token" }, 401);
	}

	const dbi = getDb(env);
	await ensureExtraSchema(dbi);

	const proof = await verifyDeviceProof(c.req.raw, dbi, {
		tenantId: claims.tenantId,
		deviceId: claims.deviceId,
	});
	if (!proof.ok) return c.json({ ok: false, error: proof.error }, 401);

	const lic = await getLicenseByHash(dbi, claims.licHash);
	if (!lic) return c.json({ ok: false, error: "not_found" }, 404);

	return c.json({
		ok: true,
		state: {
			tenant_id: lic.tenant_id,
			status: lic.status,
			expires_at: lic.expires_at,
			disabled: toBool01((lic as any).disabled, false),
			test_mode: toBool01((lic as any).test_mode, false),
			key_short: lic.key_short,
			updated_at_ms: lic.updated_at_ms,
			created_at_ms: lic.created_at_ms,
		},
		serverTime: Date.now(),
	});
});

// ──────────────────────────────────────────────────────────────────────────────
// /v1/webhooks  (Lemon Squeezy)
// ──────────────────────────────────────────────────────────────────────────────

export const lemonWebhookRoutes = new Hono<Ctx>();

// POST /v1/webhooks/lemon
lemonWebhookRoutes.post("/lemon", async (c) => {
	const env = c.env;
	const miss = assertEnv(env, [
		"LEMON_WEBHOOK_SECRET",
		"TURSO_DATABASE_URL",
		"TURSO_AUTH_TOKEN",
		"LICENSE_STORE_KEY",
	]);
	if (miss) return c.json({ ok: false, error: miss }, 500);

	const raw = await c.req.raw.text();

	console.log("[LEMON] webhook hit", {
		ts: Date.now(),
		sigPresent: Boolean((c.req.header("X-Signature") || "").trim()),
		bytes: raw.length,
	});

	const validSig = await verifyLemonSignature(c.req.raw, env.LEMON_WEBHOOK_SECRET, raw);
	if (!validSig) return c.json({ ok: false, error: "invalid_signature" }, 401);

	const sig = (c.req.header("X-Signature") || "").trim().toLowerCase();
	const bodySha = await sha256Hex(raw);
	const eventUid = await sha256Hex(sig + ":" + bodySha);

	const dbi = getDb(env);
	await ensureExtraSchema(dbi);

	let payload: LemonWebhookPayload | null = null;
	try {
		payload = JSON.parse(raw);
	} catch {
		return c.json({ ok: false, error: "invalid_json" }, 400);
	}

	const eventName = String(payload?.meta?.event_name || "");
	const testMode = Boolean(payload?.meta?.test_mode);

	const resourceType = (payload as any)?.data?.type ? String((payload as any).data.type) : null;
	const resourceId = (payload as any)?.data?.id ? String((payload as any).data.id) : null;

	const idemp = await upsertWebhookEvent(dbi, {
		event_uid: eventUid,
		event_name: eventName || "unknown",
		resource_type: resourceType,
		resource_id: resourceId,
		sig_hex: sig || null,
		body_sha256: bodySha,
		payload_json: raw,
	});

	if (idemp.already) {
		return c.json({ ok: true, received: true, eventName, idempotent: true });
	}

	try {
		const attrs = payload?.data?.attributes || {};
		const licenseKey = String((attrs as any).key || "").trim();
		const status = String((attrs as any).status || "unknown").trim() as LicenseStatus;
		const expiresAt = (attrs as any).expires_at ? String((attrs as any).expires_at) : null;

		console.log("[LEMON] event", {
			eventName,
			hasKey: Boolean(licenseKey),
			status,
			expiresAt,
			testMode,
		});

		if (licenseKey) {
			await upsertLicenseFromEventOrActivation({
				db: dbi,
				storeKeyB64: env.LICENSE_STORE_KEY,
				licenseKeyPlain: licenseKey,
				tenantId: null,
				status: (status || "active") as LicenseStatus,
				expiresAt,
				testMode,

				lemon_license_key_id: resourceId,
				lemon_created_at: (attrs as any).created_at ? String((attrs as any).created_at) : null,
				lemon_updated_at: (attrs as any).updated_at ? String((attrs as any).updated_at) : null,

				meta: { eventName, payload },
			});
		}

		await markWebhookProcessed(dbi, eventUid, true);
		return c.json({ ok: true, received: true, eventName });
	} catch (e: any) {
		await markWebhookProcessed(dbi, eventUid, false, String(e?.message || e));
		return c.json({ ok: false, error: "webhook_processing_failed" }, 500);
	}
});
