// src/server/licenseStore.ts
//
// Almacén del control-plane de licencias (Turso central). Aquí vive TODO el SQL de
// `licenses`, del OTP de cambio de dispositivo, de los dispositivos y de los eventos de
// webhook. Las reglas (¿está caducada? ¿avisa? ¿bloquea?) NO están aquí: son de
// `licensing.helpers.ts` (`computeLicenseState`).
//
// El esquema NO se crea desde el código: vive en la migración versionada
// `docs/sql/control-plane/2026-07-14_licencias_propias.sql`, que se ejecuta a mano contra
// Turso. Si falta, las consultas fallan ruidosamente — que es lo que queremos.
//
// Invariantes:
//   · La clave en claro NUNCA se guarda: solo `sha256` (único, indexado) y AES-GCM.
//   · Una licencia = un tenant = un Main (`main_device_id`). Cambiarlo exige OTP (§6.4).
//   · `customer_email` es obligatorio: es la raíz de confianza de la recuperación.

import type { Client } from "@libsql/client/web";

import type { LicenseOrigin, LicenseStatus } from "../shared";
import { aesGcmEncrypt } from "./crypto";
import { generateLicenseKey, licenseKeyHash, licenseKeyShort } from "../domains/licensing/licenseKey";
import { exec } from "./db";

export type LicenseRow = {
	license_id: string;
	license_key_hash: string;
	license_key_enc: string | null;
	key_short: string | null;

	tenant_id: string | null;
	main_device_id: string | null;

	status: LicenseStatus;
	disabled: number;

	plan: string;
	term_months: number;
	origin: LicenseOrigin;

	issued_at_ms: number;
	activated_at_ms: number | null;
	expires_at_ms: number | null;

	customer_email: string;
	customer_name: string | null;

	stripe_customer_id: string | null;
	stripe_checkout_session_id: string | null;
	stripe_payment_intent_id: string | null;
	stripe_price_id: string | null;

	created_at_ms: number;
	updated_at_ms: number;
};

/* ============================================================
   Fechas
============================================================ */

/**
 * Suma meses de calendario. Si el día no existe en el mes destino (31 de enero + 1 mes),
 * cae al último día del mes, en vez de desbordar a marzo como haría `setMonth` a pelo.
 */
export function addMonths(fromMs: number, months: number): number {
	const d = new Date(fromMs);
	const day = d.getUTCDate();

	d.setUTCDate(1);
	d.setUTCMonth(d.getUTCMonth() + months);

	const lastDay = new Date(
		Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
	).getUTCDate();
	d.setUTCDate(Math.min(day, lastDay));

	return d.getTime();
}

/* ============================================================
   Lecturas
============================================================ */

export async function getLicenseByHash(db: Client, licHash: string): Promise<LicenseRow | null> {
	const r = await exec(db, `SELECT * FROM licenses WHERE license_key_hash = ? LIMIT 1;`, [licHash]);
	return (r.rows?.[0] as unknown as LicenseRow) ?? null;
}

export async function getLicenseById(db: Client, licenseId: string): Promise<LicenseRow | null> {
	const r = await exec(db, `SELECT * FROM licenses WHERE license_id = ? LIMIT 1;`, [licenseId]);
	return (r.rows?.[0] as unknown as LicenseRow) ?? null;
}

export async function getLicenseByStripeSession(
	db: Client,
	sessionId: string,
): Promise<LicenseRow | null> {
	const r = await exec(
		db,
		`SELECT * FROM licenses WHERE stripe_checkout_session_id = ? LIMIT 1;`,
		[sessionId],
	);
	return (r.rows?.[0] as unknown as LicenseRow) ?? null;
}

/**
 * La licencia vigente de un cliente de Stripe, para decidir si una compra nueva **extiende**
 * la que ya tiene en vez de emitirle otra clave (§4.1 del plan). Vigente = no revocada, no
 * deshabilitada y aún dentro de su `expires_at_ms` (o sin activar todavía).
 */
export async function getRenewableLicenseByStripeCustomer(
	db: Client,
	stripeCustomerId: string,
	nowMs: number,
): Promise<LicenseRow | null> {
	const r = await exec(
		db,
		`
    SELECT * FROM licenses
    WHERE stripe_customer_id = ?
      AND status IN ('issued', 'active')
      AND disabled = 0
      AND (expires_at_ms IS NULL OR expires_at_ms > ?)
    ORDER BY expires_at_ms DESC
    LIMIT 1;
    `,
		[stripeCustomerId, nowMs],
	);
	return (r.rows?.[0] as unknown as LicenseRow) ?? null;
}

export async function listLicenses(db: Client, limit = 50, offset = 0): Promise<LicenseRow[]> {
	const r = await exec(
		db,
		`SELECT * FROM licenses ORDER BY created_at_ms DESC LIMIT ? OFFSET ?;`,
		[limit, offset],
	);
	return (r.rows ?? []) as unknown as LicenseRow[];
}

/* ============================================================
   Emisión y ciclo de vida
============================================================ */

export type IssueLicenseArgs = {
	storeKeyB64: string;
	termMonths: number;
	origin: LicenseOrigin;
	customerEmail: string;
	customerName?: string | null;
	plan?: string;

	stripeCustomerId?: string | null;
	stripeCheckoutSessionId?: string | null;
	stripePaymentIntentId?: string | null;
	stripePriceId?: string | null;
};

/**
 * Minta una licencia nueva. Devuelve la fila **y la clave en claro**: es la única vez que
 * existe fuera del email del cliente — quien llame decide si la envía o la muestra, y no
 * debe loguearla.
 *
 * `status = 'issued'` y `expires_at_ms = NULL`: el reloj no arranca en la compra, sino en
 * la 1ª activación (decisión §4.1 — "compra la clave y actívala cuando montes el TPV").
 */
export async function issueLicense(
	db: Client,
	args: IssueLicenseArgs,
): Promise<{ license: LicenseRow; keyPlain: string }> {
	const keyPlain = generateLicenseKey();
	const licHash = await licenseKeyHash(keyPlain);
	const keyEnc = await aesGcmEncrypt(args.storeKeyB64, keyPlain);

	const now = Date.now();
	const licenseId = crypto.randomUUID();

	await exec(
		db,
		`
    INSERT INTO licenses (
      license_id, license_key_hash, license_key_enc, key_short,
      tenant_id, main_device_id,
      status, disabled,
      plan, term_months, origin,
      issued_at_ms, activated_at_ms, expires_at_ms,
      customer_email, customer_name,
      stripe_customer_id, stripe_checkout_session_id, stripe_payment_intent_id, stripe_price_id,
      created_at_ms, updated_at_ms
    ) VALUES (
      ?, ?, ?, ?,
      NULL, NULL,
      'issued', 0,
      ?, ?, ?,
      ?, NULL, NULL,
      ?, ?,
      ?, ?, ?, ?,
      ?, ?
    );
    `,
		[
			licenseId,
			licHash,
			keyEnc,
			licenseKeyShort(keyPlain),
			args.plan ?? "standard",
			args.termMonths,
			args.origin,
			now,
			args.customerEmail,
			args.customerName ?? null,
			args.stripeCustomerId ?? null,
			args.stripeCheckoutSessionId ?? null,
			args.stripePaymentIntentId ?? null,
			args.stripePriceId ?? null,
			now,
			now,
		],
	);

	const license = (await getLicenseById(db, licenseId))!;
	return { license, keyPlain };
}

/**
 * 1ª activación: arranca el reloj y liga la licencia a su tenant y a su Main.
 * Condicionada en SQL a que siga sin activar (`main_device_id IS NULL`), para que dos
 * activaciones simultáneas no puedan pisarse.
 */
export async function activateLicenseFirstTime(
	db: Client,
	args: { licenseId: string; tenantId: string; deviceId: string; termMonths: number },
): Promise<number> {
	const now = Date.now();
	const expiresAt = addMonths(now, args.termMonths);

	await exec(
		db,
		`
    UPDATE licenses
    SET status='active',
        tenant_id=?,
        main_device_id=?,
        activated_at_ms=?,
        expires_at_ms=?,
        updated_at_ms=?
    WHERE license_id=? AND main_device_id IS NULL;
    `,
		[args.tenantId, args.deviceId, now, expiresAt, now, args.licenseId],
	);

	return expiresAt;
}

/** Reasigna el Main (cambio de dispositivo, §6.4) y deja la traza de auditoría. */
export async function reassignMainDevice(
	db: Client,
	args: { licenseId: string; fromDeviceId: string | null; toDeviceId: string },
): Promise<void> {
	const now = Date.now();

	await exec(
		db,
		`UPDATE licenses SET main_device_id=?, updated_at_ms=? WHERE license_id=?;`,
		[args.toDeviceId, now, args.licenseId],
	);

	await exec(
		db,
		`
    INSERT INTO license_device_swaps (swap_id, license_id, from_device_id, to_device_id, at_ms)
    VALUES (?, ?, ?, ?, ?);
    `,
		[crypto.randomUUID(), args.licenseId, args.fromDeviceId, args.toDeviceId, now],
	);
}

/**
 * Extiende la licencia. Si aún no ha caducado, suma sobre `expires_at_ms` (no se pierde lo
 * que quedaba); si ya venció (o nunca se activó), cuenta desde ahora.
 */
export async function extendLicense(
	db: Client,
	licenseId: string,
	months: number,
): Promise<number> {
	const lic = await getLicenseById(db, licenseId);
	if (!lic) throw new Error("license_not_found");

	const now = Date.now();
	const base = lic.expires_at_ms && lic.expires_at_ms > now ? lic.expires_at_ms : now;
	const expiresAt = addMonths(base, months);

	await exec(
		db,
		`
    UPDATE licenses
    SET expires_at_ms=?,
        status = CASE WHEN status='expired' THEN 'active' ELSE status END,
        updated_at_ms=?
    WHERE license_id=?;
    `,
		[expiresAt, now, licenseId],
	);

	return expiresAt;
}

/**
 * Sella la licencia con la sesión de Stripe que acaba de pagarla. El índice único sobre
 * `stripe_checkout_session_id` convierte esto en la barrera de idempotencia del fulfillment:
 * si el webhook se reprocesa, la sesión ya está sellada y no se vuelve a extender.
 */
export async function attachStripeSession(
	db: Client,
	licenseId: string,
	args: {
		sessionId: string;
		customerId?: string | null;
		paymentIntentId?: string | null;
		priceId?: string | null;
	},
): Promise<void> {
	await exec(
		db,
		`
    UPDATE licenses
    SET stripe_checkout_session_id=?,
        stripe_customer_id=COALESCE(?, stripe_customer_id),
        stripe_payment_intent_id=COALESCE(?, stripe_payment_intent_id),
        stripe_price_id=COALESCE(?, stripe_price_id),
        updated_at_ms=?
    WHERE license_id=?;
    `,
		[
			args.sessionId,
			args.customerId ?? null,
			args.paymentIntentId ?? null,
			args.priceId ?? null,
			Date.now(),
			licenseId,
		],
	);
}

export async function revokeLicense(db: Client, licenseId: string): Promise<void> {
	const now = Date.now();
	await exec(
		db,
		`UPDATE licenses SET status='revoked', disabled=1, updated_at_ms=? WHERE license_id=?;`,
		[now, licenseId],
	);
}

/** Persiste los datos del negocio que llegan en la activación (corrige el bug #5). */
export async function upsertTenantInfo(
	db: Client,
	tenantId: string,
	info: {
		displayName?: string | null;
		legalName?: string | null;
		email?: string | null;
		phone?: string | null;
		country?: string | null;
	},
): Promise<void> {
	const now = Date.now();
	await exec(
		db,
		`
    UPDATE tenants
    SET display_name = COALESCE(?, display_name),
        legal_name   = COALESCE(?, legal_name),
        email        = COALESCE(?, email),
        phone        = COALESCE(?, phone),
        country      = COALESCE(?, country),
        updated_at_ms = ?
    WHERE tenant_id = ?;
    `,
		[
			info.displayName ?? null,
			info.legalName ?? null,
			info.email ?? null,
			info.phone ?? null,
			info.country ?? null,
			now,
			tenantId,
		],
	);
}

export async function ensureTenantExistsMinimal(db: Client, tenantId: string) {
	const now = Date.now();
	await exec(
		db,
		`
    INSERT INTO tenants (tenant_id, status, created_at_ms, updated_at_ms)
    VALUES (?, 'active', ?, ?)
    ON CONFLICT(tenant_id) DO UPDATE SET
      updated_at_ms=excluded.updated_at_ms;
    `,
		[tenantId, now, now],
	);
}

/* ============================================================
   OTP de cambio de dispositivo (§6.4)
============================================================ */

export type DeviceOtpRow = {
	license_id: string;
	new_device_id: string;
	code_hash: string;
	attempts: number;
	expires_at_ms: number;
	consumed_at_ms: number | null;
	created_at_ms: number;
};

/**
 * Guarda el OTP (solo su hash) ligado a la licencia **y al dispositivo concreto** que pide
 * el cambio: un código pescado del correo no sirve para activar en un tercer equipo.
 * Pedir un código nuevo sustituye al anterior y reinicia los intentos.
 */
export async function putDeviceOtp(
	db: Client,
	args: { licenseId: string; newDeviceId: string; codeHash: string; expiresAtMs: number },
): Promise<void> {
	const now = Date.now();
	await exec(
		db,
		`
    INSERT INTO license_device_otp (
      license_id, new_device_id, code_hash, attempts, expires_at_ms, consumed_at_ms, created_at_ms
    ) VALUES (?, ?, ?, 0, ?, NULL, ?)
    ON CONFLICT(license_id, new_device_id) DO UPDATE SET
      code_hash=excluded.code_hash,
      attempts=0,
      expires_at_ms=excluded.expires_at_ms,
      consumed_at_ms=NULL,
      created_at_ms=excluded.created_at_ms;
    `,
		[args.licenseId, args.newDeviceId, args.codeHash, args.expiresAtMs, now],
	);
}

export async function getDeviceOtp(
	db: Client,
	licenseId: string,
	newDeviceId: string,
): Promise<DeviceOtpRow | null> {
	const r = await exec(
		db,
		`SELECT * FROM license_device_otp WHERE license_id=? AND new_device_id=? LIMIT 1;`,
		[licenseId, newDeviceId],
	);
	return (r.rows?.[0] as unknown as DeviceOtpRow) ?? null;
}

export async function bumpDeviceOtpAttempts(
	db: Client,
	licenseId: string,
	newDeviceId: string,
): Promise<void> {
	await exec(
		db,
		`UPDATE license_device_otp SET attempts = attempts + 1 WHERE license_id=? AND new_device_id=?;`,
		[licenseId, newDeviceId],
	);
}

/**
 * Consume el OTP de forma **atómica**: solo consume si sigue sin consumir. Devuelve `false`
 * si otro intento se le adelantó (anti-replay ante peticiones concurrentes).
 */
export async function consumeDeviceOtp(
	db: Client,
	licenseId: string,
	newDeviceId: string,
): Promise<boolean> {
	const r = await exec(
		db,
		`
    UPDATE license_device_otp
    SET consumed_at_ms = ?
    WHERE license_id=? AND new_device_id=? AND consumed_at_ms IS NULL
    RETURNING license_id;
    `,
		[Date.now(), licenseId, newDeviceId],
	);
	return (r.rows?.length ?? 0) > 0;
}

/* ============================================================
   Dispositivos (anti-copia por pubkey ed25519)
============================================================ */

export async function getDevicePubKeyB64(
	db: Client,
	tenantId: string,
	deviceId: string,
): Promise<string | null> {
	const r = await exec(
		db,
		`SELECT device_pubkey_b64 FROM devices WHERE tenant_id=? AND device_id=? LIMIT 1;`,
		[tenantId, deviceId],
	);
	const row = (r.rows?.[0] as any) || null;
	const v = row ? String(row.device_pubkey_b64 || "").trim() : "";
	return v ? v : null;
}

/** Guarda la pubkey solo si está vacía. Si ya hay otra distinta → error (anti-clonado). */
export async function setDevicePubKeyB64IfEmptyOrThrow(
	db: Client,
	tenantId: string,
	deviceId: string,
	pubB64: string,
) {
	const cur = await getDevicePubKeyB64(db, tenantId, deviceId);
	if (!cur) {
		await exec(
			db,
			`UPDATE devices SET device_pubkey_b64=?, pubkey_alg='ed25519' WHERE tenant_id=? AND device_id=?;`,
			[pubB64, tenantId, deviceId],
		);
		return;
	}
	if (cur !== pubB64) {
		const err: any = new Error("device_key_mismatch");
		err.code = "device_key_mismatch";
		throw err;
	}
}

export async function ensureDevice(
	db: Client,
	tenantId: string,
	deviceId: string,
	role: "tpv" | "handy" = "tpv",
	devicePubKeyB64?: string | null,
) {
	const now = Date.now();

	await exec(
		db,
		`
    INSERT INTO devices (device_id, tenant_id, role, first_seen_at_ms, last_seen_at_ms)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      tenant_id=excluded.tenant_id,
      role=excluded.role,
      last_seen_at_ms=excluded.last_seen_at_ms;
    `,
		[deviceId, tenantId, role, now, now],
	);

	if (devicePubKeyB64 && devicePubKeyB64.trim()) {
		await setDevicePubKeyB64IfEmptyOrThrow(db, tenantId, deviceId, devicePubKeyB64.trim());
	}
}

/* ============================================================
   Eventos de webhook (idempotencia) — ahora de Stripe
============================================================ */

export async function upsertWebhookEvent(
	db: Client,
	args: {
		event_uid: string;
		event_name: string;
		resource_type: string | null;
		resource_id: string | null;
		sig_hex: string | null;
		body_sha256: string;
		payload_json: string;
	},
) {
	const now = Date.now();

	const existing = await exec(
		db,
		`SELECT processed_ok FROM webhook_events WHERE event_uid=? LIMIT 1;`,
		[args.event_uid],
	);
	if (existing.rows?.length) return { already: true };

	await exec(
		db,
		`
    INSERT INTO webhook_events (
      event_uid, event_name, resource_type, resource_id,
      sig_hex, body_sha256, payload_json,
      received_at_ms, processed_at_ms, processed_ok, error_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL);
    `,
		[
			args.event_uid,
			args.event_name,
			args.resource_type,
			args.resource_id,
			args.sig_hex,
			args.body_sha256,
			args.payload_json,
			now,
		],
	);

	return { already: false };
}

export async function markWebhookProcessed(
	db: Client,
	eventUid: string,
	ok: boolean,
	errorText?: string | null,
) {
	const now = Date.now();
	await exec(
		db,
		`UPDATE webhook_events SET processed_at_ms=?, processed_ok=?, error_text=? WHERE event_uid=?;`,
		[now, ok ? 1 : 0, ok ? null : errorText || "error", eventUid],
	);
}

/* ============================================================
   Auditoría de admin
============================================================ */

export async function auditAdmin(
	db: Client,
	action: "issue" | "revoke" | "extend",
	licenseId: string | null,
	detail: Record<string, unknown>,
) {
	await exec(
		db,
		`INSERT INTO admin_audit (audit_id, action, license_id, detail, at_ms) VALUES (?, ?, ?, ?, ?);`,
		[crypto.randomUUID(), action, licenseId, JSON.stringify(detail), Date.now()],
	);
}
