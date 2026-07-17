// src/domains/admin/admin.routes.ts
//
// Alta manual de licencias. Sin panel web: solo estos endpoints + el CLI (`pnpm license:*`),
// protegidos por `ADMIN_API_TOKEN` con comparación *timing-safe*. Cuanta menos superficie,
// menos que defender: no hay sesiones, ni cookies, ni CSRF.
//
//   POST /v1/admin/licenses             → emite una clave
//   GET  /v1/admin/licenses             → lista
//   POST /v1/admin/licenses/:id/revoke  → anula
//   POST /v1/admin/licenses/:id/extend  → suma meses
//
// La clave en claro se devuelve UNA sola vez, en la respuesta del issue: después ya solo existe
// cifrada. Si el cliente la pierde, se reemite.

import { Hono } from "hono";
import { z } from "zod";

import type { Env } from "../../env";
import { requireAdmin } from "../../middleware/requireAdmin";
import { ensureLicensingSchemaMw } from "../../middleware/ensureSchema";
import { getDb } from "../../server/db";
import { aesGcmDecrypt } from "../../server/crypto";
import {
	auditAdmin,
	extendLicense,
	getLicenseById,
	issueLicense,
	listLicenses,
	markKeyEmailSent,
	revokeLicense,
} from "../../server/licenseStore";
import { sendLicenseKeyEmail } from "../licensing/licenseEmails";
import { assertEnv } from "../licensing/licensing.helpers";

export const adminRoutes = new Hono<{ Bindings: Env }>();

adminRoutes.use("*", requireAdmin);
adminRoutes.use("*", ensureLicensingSchemaMw);

/** Las tres duraciones del producto. Un plazo fuera de aquí es un error de tecleo. */
const TERMS = [1, 3, 12] as const;

const issueSchema = z.object({
	termMonths: z.union([z.literal(1), z.literal(3), z.literal(12)]),
	// Obligatorio: es la raíz de confianza del cambio de dispositivo (§6.4). Sin email, ese
	// cliente no puede recuperar su licencia sin pasar por ti.
	email: z.string().email("email inválido"),
	name: z.string().max(200).optional(),
	/** Si es `true`, además de devolver la clave se la enviamos al cliente por correo. */
	sendKey: z.boolean().optional(),
});

adminRoutes.post("/licenses", async (c) => {
	const env = c.env;
	const miss = assertEnv(env, ["LICENSE_STORE_KEY", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"]);
	if (miss) return c.json({ ok: false, error: miss }, 500);

	const parsed = issueSchema.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) {
		return c.json({ ok: false, error: "validation_error", issues: parsed.error.issues }, 400);
	}

	const { termMonths, email, name, sendKey } = parsed.data;
	const db = getDb(env);

	const { license, keyPlain } = await issueLicense(db, {
		storeKeyB64: env.LICENSE_STORE_KEY,
		termMonths,
		origin: "manual",
		customerEmail: email.trim().toLowerCase(),
		customerName: name?.trim() || null,
	});

	// La clave NO se loguea: solo el hash corto que ya es público en la UI.
	await auditAdmin(db, "issue", license.license_id, {
		termMonths,
		email: license.customer_email,
		keyShort: license.key_short,
		sendKey: Boolean(sendKey),
	});

	let emailSent: boolean | null = null;
	if (sendKey) {
		emailSent = await sendLicenseKeyEmail(env, {
			to: license.customer_email,
			name: license.customer_name,
			key: keyPlain,
			termMonths,
		});
	}

	return c.json({
		ok: true,
		licenseId: license.license_id,
		key: keyPlain,
		keyShort: license.key_short,
		termMonths,
		email: license.customer_email,
		emailSent,
	});
});

/**
 * Recupera y reenvía la clave de una licencia. Es la red de seguridad del "pagó y no le llegó el
 * correo": la clave en claro solo existe cifrada (`license_key_enc`), así que aquí se descifra, se
 * reenvía al `customer_email` y **se devuelve también en la respuesta** para que el admin tenga
 * siempre una salida manual aunque el email vuelva a fallar.
 */
adminRoutes.post("/licenses/:id/resend-key", async (c) => {
	const env = c.env;
	const miss = assertEnv(env, ["LICENSE_STORE_KEY", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"]);
	if (miss) return c.json({ ok: false, error: miss }, 500);

	const db = getDb(env);
	const licenseId = c.req.param("id");

	const lic = await getLicenseById(db, licenseId);
	if (!lic) return c.json({ ok: false, error: "license_not_found" }, 404);
	if (!lic.license_key_enc) return c.json({ ok: false, error: "key_unavailable" }, 409);

	const keyPlain = await aesGcmDecrypt(env.LICENSE_STORE_KEY, lic.license_key_enc);

	const emailSent = await sendLicenseKeyEmail(env, {
		to: lic.customer_email,
		name: lic.customer_name,
		key: keyPlain,
		termMonths: lic.term_months,
	});
	if (emailSent) await markKeyEmailSent(db, licenseId);

	await auditAdmin(db, "resend", licenseId, { email: lic.customer_email, emailSent });

	return c.json({
		ok: true,
		licenseId,
		key: keyPlain,
		keyShort: lic.key_short,
		email: lic.customer_email,
		emailSent,
	});
});

adminRoutes.get("/licenses", async (c) => {
	const db = getDb(c.env);

	const limit = Math.min(Number(c.req.query("limit") || 50), 200);
	const offset = Number(c.req.query("offset") || 0);

	const rows = await listLicenses(db, limit, offset);

	// Nunca se devuelve `license_key_enc` ni el hash: no hacen falta para operar y son material
	// sensible.
	return c.json({
		ok: true,
		licenses: rows.map((l) => ({
			licenseId: l.license_id,
			keyShort: l.key_short,
			status: l.status,
			disabled: Boolean(l.disabled),
			plan: l.plan,
			termMonths: l.term_months,
			origin: l.origin,
			customerEmail: l.customer_email,
			customerName: l.customer_name,
			tenantId: l.tenant_id,
			mainDeviceId: l.main_device_id,
			issuedAt: new Date(l.issued_at_ms).toISOString(),
			activatedAt: l.activated_at_ms ? new Date(l.activated_at_ms).toISOString() : null,
			expiresAt: l.expires_at_ms ? new Date(l.expires_at_ms).toISOString() : null,
			keyEmailSentAt: l.key_email_sent_at_ms ? new Date(l.key_email_sent_at_ms).toISOString() : null,
		})),
	});
});

adminRoutes.post("/licenses/:id/revoke", async (c) => {
	const db = getDb(c.env);
	const licenseId = c.req.param("id");

	const lic = await getLicenseById(db, licenseId);
	if (!lic) return c.json({ ok: false, error: "license_not_found" }, 404);

	await revokeLicense(db, licenseId);
	await auditAdmin(db, "revoke", licenseId, { keyShort: lic.key_short });

	// El TPV se entera en su siguiente /status (estado firmado = revoked) y se bloquea. Si además
	// quieres cortarle el WebSocket al instante, usa POST /v1/device/revoke con su deviceId.
	return c.json({ ok: true, licenseId, status: "revoked" });
});

const extendSchema = z.object({
	months: z.union([z.literal(1), z.literal(3), z.literal(12)]),
});

adminRoutes.post("/licenses/:id/extend", async (c) => {
	const db = getDb(c.env);
	const licenseId = c.req.param("id");

	const parsed = extendSchema.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) {
		return c.json(
			{ ok: false, error: "validation_error", details: `months debe ser ${TERMS.join(" | ")}` },
			400,
		);
	}

	const lic = await getLicenseById(db, licenseId);
	if (!lic) return c.json({ ok: false, error: "license_not_found" }, 404);

	const expiresAtMs = await extendLicense(db, licenseId, parsed.data.months);
	await auditAdmin(db, "extend", licenseId, { months: parsed.data.months, expiresAtMs });

	return c.json({
		ok: true,
		licenseId,
		expiresAt: new Date(expiresAtMs).toISOString(),
	});
});
