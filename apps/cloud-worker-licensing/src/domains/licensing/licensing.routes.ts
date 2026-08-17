// src/domains/licensing/licensing.routes.ts
//
// Las cuatro rutas que consume el TPV (cliente Rust en `crates/tpv-infra-licensing`):
//
//   POST /v1/license/activate              → canjea la clave, liga el Main, provisiona el tenant
//   POST /v1/license/device-change/request → manda el OTP para mover la licencia a otro equipo
//   GET  /v1/license/status                → estado FIRMADO (ed25519) + token renovado
//   POST /v1/license/refresh               → reemite el token caducado, autenticando por device-proof
//
// La verdad comercial es NUESTRA (tabla `licenses` en la Turso central): ya no se consulta a
// ningún tercero. Y el estado que decide el gate viaja firmado: el TLS deja de ser la única
// barrera (§5.1 del plan).

import { Hono } from "hono";

import type { Env } from "../../env";
import type { ActivateResponse, ApiError, TenantInfo } from "../../shared";
import { getDb } from "../../server/db";
import { timingSafeEqualHex } from "../../server/utils/crypto";
import {
	activateLicenseFirstTime,
	bumpDeviceOtpAttempts,
	consumeDeviceOtp,
	ensureDevice,
	ensureTenantExistsMinimal,
	getDeviceOtp,
	getLicenseByHash,
	putDeviceOtp,
	reassignMainDevice,
	getOrCreateTenantFieldDek,
	setDevicePubKeyB64IfEmptyOrThrow,
	upsertTenantInfo,
	type LicenseRow,
} from "../../server/licenseStore";
import { ensureLicensingSchemaMw } from "../../middleware/ensureSchema";
import { licenseKeyHash, normalizeLicenseKey } from "./licenseKey";
import { sendDeviceChangeCodeEmail, sendDeviceChangedNoticeEmail } from "./licenseEmails";
import {
	assertEnv,
	buildSignedAssertion,
	computeLicenseState,
	decodeTokenClaims,
	emailHint,
	generateOtpCode,
	GRACE_DAYS,
	OTP_MAX_ATTEMPTS,
	OTP_TTL_MS,
	otpHash,
	provisionTenantDatabase,
	signToken,
	toBool01,
	verifyDeviceProof,
	verifyToken,
} from "./licensing.helpers";

type Ctx = { Bindings: Env };

export const licenseRoutes = new Hono<Ctx>();

licenseRoutes.use("*", ensureLicensingSchemaMw);

const DAY_MS = 24 * 60 * 60 * 1000;

/** ¿La licencia está tan caducada que ya no se puede ni activar? (pasada también la gracia) */
function estaCaducada(lic: LicenseRow, nowMs: number): boolean {
	if (!lic.expires_at_ms) return false;
	return nowMs > lic.expires_at_ms + GRACE_DAYS * DAY_MS;
}

/** ¿La licencia está anulada? */
function estaAnulada(lic: LicenseRow): boolean {
	return lic.status === "revoked" || toBool01(lic.disabled);
}

// ──────────────────────────────────────────────────────────────────────────────
// POST /v1/license/activate
// ──────────────────────────────────────────────────────────────────────────────

licenseRoutes.post("/activate", async (c) => {
	const env = c.env;
	const miss = assertEnv(env, [
		"LICENSE_JWT_SECRET",
		// TRAB-03: cifra la DEK del tenant en reposo. Fail-closed: sin este secreto no se
		// activa, en vez de aprovisionar un tenant sin clave de cifrado que luego habría
		// que rellenar a mano.
		"LICENSE_STORE_KEY",
		"TURSO_DATABASE_URL",
		"TURSO_AUTH_TOKEN",
		"TURSO_PLATFORM_TOKEN",
		"TURSO_ORG_SLUG",
	]);
	if (miss) return c.json({ ok: false, error: miss } satisfies ApiError, 500);

	const ct = c.req.header("content-type") || "";
	if (!ct.toLowerCase().includes("application/json")) {
		return c.json({ ok: false, error: "Content-Type must be application/json" }, 415);
	}

	const body = await c.req.json<any>().catch(() => ({}));

	const activationKey = normalizeLicenseKey(String(body?.activationKey || ""));
	if (!activationKey) {
		return c.json({ ok: false, error: "license_not_found" } satisfies ApiError, 404);
	}

	const deviceId = String(body?.deviceId || "").trim() || crypto.randomUUID();
	const devicePubKey = String(body?.devicePubKey || "").trim();
	if (!devicePubKey) {
		return c.json({ ok: false, error: "devicePubKey required" } satisfies ApiError, 400);
	}

	const deviceChangeCode = String(body?.deviceChangeCode || "").trim();
	const tenantInfo: TenantInfo = body?.tenantInfo || {};

	const db = getDb(env);
	const now = Date.now();

	const licHash = await licenseKeyHash(activationKey);
	const lic = await getLicenseByHash(db, licHash);

	// Mismo error para "no existe" que para un formato válido pero desconocido: no damos pistas
	// sobre qué claves existen.
	if (!lic) return c.json({ ok: false, error: "license_not_found" } satisfies ApiError, 404);
	if (estaAnulada(lic)) {
		return c.json({ ok: false, error: "license_revoked" } satisfies ApiError, 403);
	}
	if (estaCaducada(lic, now)) {
		return c.json({ ok: false, error: "license_expired" } satisfies ApiError, 403);
	}

	const esPrimeraActivacion = !lic.main_device_id;
	const esMismoEquipo = lic.main_device_id === deviceId;
	const esCambioDeEquipo = !esPrimeraActivacion && !esMismoEquipo;

	// ── Cambio de equipo: exige el OTP del email (§6.4) ──────────────────────
	if (esCambioDeEquipo) {
		if (!deviceChangeCode) {
			return c.json(
				{
					ok: false,
					error: "device_change_required",
					details: { emailHint: emailHint(lic.customer_email) },
				} satisfies ApiError,
				409,
			);
		}

		const otp = await getDeviceOtp(db, lic.license_id, deviceId);
		if (!otp || otp.consumed_at_ms) {
			return c.json({ ok: false, error: "invalid_code" } satisfies ApiError, 401);
		}
		if (otp.attempts >= OTP_MAX_ATTEMPTS) {
			return c.json({ ok: false, error: "too_many_attempts" } satisfies ApiError, 429);
		}
		if (now > otp.expires_at_ms) {
			return c.json({ ok: false, error: "code_expired" } satisfies ApiError, 401);
		}

		const presentado = await otpHash(deviceChangeCode);
		if (!timingSafeEqualHex(presentado, otp.code_hash)) {
			await bumpDeviceOtpAttempts(db, lic.license_id, deviceId);
			return c.json({ ok: false, error: "invalid_code" } satisfies ApiError, 401);
		}

		// Consumo atómico: si dos peticiones llegan a la vez con el código bueno, solo una gana.
		const consumido = await consumeDeviceOtp(db, lic.license_id, deviceId);
		if (!consumido) {
			return c.json({ ok: false, error: "invalid_code" } satisfies ApiError, 401);
		}
	}

	// ── Tenant + dispositivo ────────────────────────────────────────────────
	const tenantId = lic.tenant_id || crypto.randomUUID();

	await ensureTenantExistsMinimal(db, tenantId);

	try {
		// Liga la pubkey del dispositivo (anti-copia). Si ese device_id ya existía con OTRA
		// clave, esto lanza `device_key_mismatch`: alguien ha copiado el fichero de estado.
		await ensureDevice(db, tenantId, deviceId, "tpv", devicePubKey);
		await setDevicePubKeyB64IfEmptyOrThrow(db, tenantId, deviceId, devicePubKey);
	} catch (e: any) {
		if (e?.code === "device_key_mismatch") {
			return c.json({ ok: false, error: "device_key_mismatch" } satisfies ApiError, 409);
		}
		throw e;
	}

	try {
		await provisionTenantDatabase(db, env, tenantId);
	} catch (e: any) {
		const detalle = String(e?.message || e);
		// Al log (visible con `wrangler tail`): el detalle de Turso es la clave para diagnosticar
		// (401 = token de plataforma malo, 404 = org/grupo inexistente, límite de plan, etc.).
		console.error("[activate] tenant_db_provision_failed:", detalle);
		return c.json(
			{ ok: false, error: "tenant_db_provision_failed", details: detalle } satisfies ApiError,
			500,
		);
	}

	await upsertTenantInfo(db, tenantId, {
		displayName: tenantInfo.displayName ?? null,
		legalName: tenantInfo.legalName ?? null,
		email: tenantInfo.email ?? null,
		phone: tenantInfo.phone ?? null,
		country: tenantInfo.country ?? null,
	});

	// ── Licencia: arrancar el reloj o mover el Main ─────────────────────────
	let expiresAtMs = lic.expires_at_ms;

	if (esPrimeraActivacion) {
		expiresAtMs = await activateLicenseFirstTime(db, {
			licenseId: lic.license_id,
			tenantId,
			deviceId,
			termMonths: lic.term_months,
		});
	} else if (esCambioDeEquipo) {
		await reassignMainDevice(db, {
			licenseId: lic.license_id,
			fromDeviceId: lic.main_device_id,
			toDeviceId: deviceId,
		});

		// Aviso al titular: si el cambio no lo ha hecho él, queremos que se entere HOY.
		// No bloquea la activación: el correo es entrega, no autorización.
		c.executionCtx.waitUntil(sendDeviceChangedNoticeEmail(env, { to: lic.customer_email }));
	}

	const token = await signToken(env, { tenantId, deviceId, licHash });

	// TRAB-03: la clave con la que la Main cifra DNI/IBAN/nº SS. Se entrega en cada
	// activación (no sólo en la primera) porque es justo lo que necesita un equipo nuevo
	// tras un cambio de dispositivo para poder volver a leer los datos del personal.
	const fieldDek = await getOrCreateTenantFieldDek(db, env.LICENSE_STORE_KEY, tenantId);

	const out: ActivateResponse = {
		ok: true,
		tenantId,
		deviceId,
		token,
		status: esPrimeraActivacion ? "active" : lic.status,
		expiresAt: expiresAtMs ? new Date(expiresAtMs).toISOString() : null,
		fieldDek,
	};

	return c.json(out);
});

// ──────────────────────────────────────────────────────────────────────────────
// POST /v1/license/device-change/request
// ──────────────────────────────────────────────────────────────────────────────
//
// Manda el código de 6 dígitos al email de la licencia. Responde SIEMPRE lo mismo, exista o no
// la clave: si contestara distinto, cualquiera podría usar este endpoint para averiguar qué
// claves son válidas.

licenseRoutes.post("/device-change/request", async (c) => {
	const env = c.env;
	const miss = assertEnv(env, ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN", "EMAIL_FROM_ADDRESS"]);
	if (miss) return c.json({ ok: false, error: miss } satisfies ApiError, 500);

	const body = await c.req.json<any>().catch(() => ({}));
	const activationKey = normalizeLicenseKey(String(body?.activationKey || ""));
	const deviceId = String(body?.deviceId || "").trim();

	const respuestaConstante = c.json({ ok: true });
	if (!activationKey || !deviceId) return respuestaConstante;

	const db = getDb(env);
	const now = Date.now();

	const lic = await getLicenseByHash(db, await licenseKeyHash(activationKey));

	// Solo se manda código si el cambio de dispositivo tiene sentido: la licencia existe, no
	// está anulada, y de verdad está ligada a OTRO equipo.
	const procede =
		lic &&
		!estaAnulada(lic) &&
		!estaCaducada(lic, now) &&
		lic.main_device_id &&
		lic.main_device_id !== deviceId;

	if (!procede || !lic) return respuestaConstante;

	// Anti-machaque: si acabamos de mandar uno hace menos de un minuto, no reenviamos (pero
	// respondemos igual). Evita usar el endpoint como cañón de correo contra un cliente.
	const previo = await getDeviceOtp(db, lic.license_id, deviceId);
	if (previo && !previo.consumed_at_ms && now - previo.created_at_ms < 60_000) {
		return respuestaConstante;
	}

	const code = generateOtpCode();
	await putDeviceOtp(db, {
		licenseId: lic.license_id,
		newDeviceId: deviceId,
		codeHash: await otpHash(code),
		expiresAtMs: now + OTP_TTL_MS,
	});

	c.executionCtx.waitUntil(
		sendDeviceChangeCodeEmail(env, {
			to: lic.customer_email,
			code,
			minutes: Math.round(OTP_TTL_MS / 60_000),
		}),
	);

	return respuestaConstante;
});

// ──────────────────────────────────────────────────────────────────────────────
// GET /v1/license/status
// ──────────────────────────────────────────────────────────────────────────────

licenseRoutes.get("/status", async (c) => {
	const env = c.env;
	const miss = assertEnv(env, [
		"LICENSE_JWT_SECRET",
		"LICENSE_SIGNING_PRIVATE_KEY",
		"TURSO_DATABASE_URL",
		"TURSO_AUTH_TOKEN",
	]);
	if (miss) return c.json({ ok: false, error: miss } satisfies ApiError, 500);

	const auth = c.req.header("authorization") || "";
	const m = auth.match(/^Bearer\s+(.+)$/i);
	if (!m) return c.json({ ok: false, error: "missing_token" } satisfies ApiError, 401);

	let claims: { tenantId: string; deviceId: string; licHash: string };
	try {
		claims = await verifyToken(env, m[1]);
	} catch {
		// Token caducado o inválido. El cliente NO debe borrar la licencia por esto: debe
		// intentar /refresh (device-proof). Se lo decimos explícitamente en el código de error.
		return c.json({ ok: false, error: "token_expired" } satisfies ApiError, 401);
	}

	const db = getDb(env);

	const rawBody = c.req.raw.body ? await c.req.text() : "";
	const proof = await verifyDeviceProof(
		c.req.raw,
		db,
		{ tenantId: claims.tenantId, deviceId: claims.deviceId },
		undefined,
		rawBody,
	);
	if (!proof.ok) return c.json({ ok: false, error: proof.error } satisfies ApiError, 401);

	const lic = await getLicenseByHash(db, claims.licHash);
	if (!lic) return c.json({ ok: false, error: "license_not_found" } satisfies ApiError, 404);

	const now = Date.now();
	const clientTs = Number(c.req.header("X-Device-Ts") || 0);

	const assertion = await buildSignedAssertion(env, {
		lic,
		tenantId: claims.tenantId,
		deviceId: claims.deviceId,
		clientTs,
		nowMs: now,
	});

	// Token renovado en cada comprobación (cada 6 h): así nunca se llega al muro de los 30 días
	// que obligaba a reactivar a mano (bug #1).
	const token = await signToken(env, claims);

	return c.json({
		ok: true,
		assertion,
		token,
		info: {
			keyShort: lic.key_short,
			customerEmail: lic.customer_email,
			termMonths: lic.term_months,
			origin: lic.origin,
		},
		serverTime: now,
	});
});

// ──────────────────────────────────────────────────────────────────────────────
// POST /v1/license/refresh
// ──────────────────────────────────────────────────────────────────────────────
//
// Reemite el token de sesión cuando el viejo ya no vale (caducó, o el reloj del equipo iba
// desajustado). NO se confía en el token: se leen sus claims sin verificar y se exige un
// device-proof firmado con la clave privada del dispositivo, que solo tiene el equipo legítimo.
// Es lo que evita que un 401 transitorio borre la licencia del cliente (bug #4).

licenseRoutes.post("/refresh", async (c) => {
	const env = c.env;
	const miss = assertEnv(env, ["LICENSE_JWT_SECRET", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"]);
	if (miss) return c.json({ ok: false, error: miss } satisfies ApiError, 500);

	const auth = c.req.header("authorization") || "";
	const m = auth.match(/^Bearer\s+(.+)$/i);
	if (!m) return c.json({ ok: false, error: "missing_token" } satisfies ApiError, 401);

	const claims = decodeTokenClaims(m[1]);
	if (!claims) return c.json({ ok: false, error: "invalid_token" } satisfies ApiError, 401);

	const db = getDb(env);

	const rawBody = c.req.raw.body ? await c.req.text() : "";
	const proof = await verifyDeviceProof(
		c.req.raw,
		db,
		{ tenantId: claims.tenantId, deviceId: claims.deviceId },
		undefined,
		rawBody,
	);
	if (!proof.ok) return c.json({ ok: false, error: proof.error } satisfies ApiError, 401);

	const lic = await getLicenseByHash(db, claims.licHash);
	if (!lic) return c.json({ ok: false, error: "license_not_found" } satisfies ApiError, 404);
	if (estaAnulada(lic)) {
		return c.json({ ok: false, error: "license_revoked" } satisfies ApiError, 403);
	}

	// Si la licencia ya se movió a otro Main, este equipo no merece un token nuevo.
	if (computeLicenseState(lic, claims.deviceId, Date.now()) === "device_replaced") {
		return c.json({ ok: false, error: "device_replaced" } satisfies ApiError, 403);
	}

	const token = await signToken(env, claims);
	return c.json({ ok: true, token });
});
