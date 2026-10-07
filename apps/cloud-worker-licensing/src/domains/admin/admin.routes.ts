// src/domains/admin/admin.routes.ts
//
// Alta manual de licencias. Sin panel web: solo estos endpoints + el CLI (`pnpm license:*`),
// protegidos por `ADMIN_API_TOKEN` con comparación *timing-safe*. Cuanta menos superficie,
// menos que defender: no hay sesiones, ni cookies, ni CSRF.
//
//   POST /v1/admin/licenses             → emite una clave
//   GET  /v1/admin/licenses             → lista
//   POST /v1/admin/licenses/:id/revoke   → anula
//   POST /v1/admin/licenses/:id/unrevoke → deshace la anulación
//   POST /v1/admin/licenses/:id/extend   → suma meses
//   POST /v1/admin/licenses/:id/shorten  → resta meses (puede dejarla caducada)
//   /v1/admin/interruptores               → interruptores remotos de emergencia (PROD-06, abajo)
//   POST /v1/admin/store-key/recifrar    → termina una rotación de LICENSE_STORE_KEY (RI-73)
//   GET|POST /v1/admin/pilotos            → qué negocios son bares piloto (RI-30, abajo)
//   GET /v1/admin/releases                → las últimas versiones, con su canal
//   POST /v1/admin/releases/promote       → pasa una versión de beta a stable
//
// La clave en claro se devuelve UNA sola vez, en la respuesta del issue: después ya solo existe
// cifrada. Si el cliente la pierde, se reemite.

import { Hono } from "hono";
import { z } from "zod";

import type { Env } from "../../env";
import { requireAdmin } from "../../middleware/requireAdmin";
import { cerrarSocketsDelDispositivo } from "../../lib/hub";
import { getDb } from "../../server/db";
import { descifrar } from "../../server/crypto";
import {
	auditAdmin,
	extendLicense,
	guardarClaveRecifrada,
	getLicenseById,
	issueLicense,
	listLicenses,
	markKeyEmailSent,
	recifrarConLaActual,
	reactivateLicense,
	revokeLicense,
	shortenLicense,
} from "../../server/licenseStore";
import { sendLicenseKeyEmail } from "../licensing/licenseEmails";
import { assertEnv } from "../licensing/licensing.helpers";
import { cuerpo } from "../../lib/validacion";
import {
	maxHoras,
	olvidarInterruptoresCacheados,
	TODOS,
	zInterruptor,
	type FilaInterruptor,
} from "../../lib/interruptores";

export const adminRoutes = new Hono<{ Bindings: Env }>();

adminRoutes.use("*", requireAdmin);

/** Las tres duraciones del producto. Un plazo fuera de aquí es un error de tecleo. */
const TERMS = [1, 3, 12] as const;

const issueSchema = z.object({
	termMonths: z.union([z.literal(1), z.literal(3), z.literal(12)]),
	// Obligatorio: es la raíz de confianza del cambio de dispositivo. Sin email, ese
	// cliente no puede recuperar su licencia sin pasar por ti.
	email: z.string().email("email inválido"),
	name: z.string().max(200).optional(),
	/** Si es `true`, además de devolver la clave se la enviamos al cliente por correo. */
	sendKey: z.boolean().optional(),
});

adminRoutes.post("/licenses", cuerpo(issueSchema), async (c) => {
	const env = c.env;
	const miss = assertEnv(env, ["LICENSE_STORE_KEY", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"]);
	if (miss) return c.json({ ok: false, error: miss }, 500);

	const { termMonths, email, name, sendKey } = c.req.valid("json");
	const db = getDb(env);

	const { license, keyPlain } = await issueLicense(db, {
		claves: env,
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

	const { texto: keyPlain, recifrado } = await descifrar(env, lic.license_key_enc);
	// RI-73: si estaba con la clave anterior, se guarda ya con la actual.
	if (recifrado) await guardarClaveRecifrada(db, licenseId, lic.license_key_enc, recifrado);

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

/** Cuántos valores pasa a la clave actual cada llamada a `/store-key/recifrar`. */
const TECHO_RECIFRADO = 200;

/**
 * RI-73 · Termina una rotación de `LICENSE_STORE_KEY`: pasa a la clave actual todo lo que siga cifrado
 * con la anterior (claves de licencia, DEK de los negocios y tokens de Turso), sin esperar a que cada
 * valor se lea. Se llama hasta que `quedanMas` sea `false`; después se puede quitar
 * `LICENSE_STORE_KEY_ANTERIOR`. Los `ilegibles` no se dejan descifrar con ninguna de las dos: se miran
 * a mano. Procedimiento: docs/arquitectura/licencias.md («Rotar LICENSE_STORE_KEY»).
 */
adminRoutes.post("/store-key/recifrar", async (c) => {
	const env = c.env;
	const miss = assertEnv(env, ["LICENSE_STORE_KEY", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"]);
	if (miss) return c.json({ ok: false, error: miss }, 500);

	const db = getDb(env);
	const r = await recifrarConLaActual(db, env, TECHO_RECIFRADO);
	await auditAdmin(db, "recifrar", null, { recifrados: r.recifrados, ilegibles: r.ilegibles.length });
	return c.json({ ok: true, ...r });
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

	// Y se le corta el WebSocket a la Main, que es lo que convierte "anulada" en "bloqueada" ahora
	// mismo. Sin esto el equipo se enteraba en la siguiente vuelta del job `licencia` — cada 6
	// horas — y mientras tanto seguía vendiendo con una licencia que ya no vale.
	//
	// Las Handy no hace falta cerrarlas: el propio DO las congela (`main_offline`) en cuanto la
	// Main se va, y al reconectar su ticket también se rechaza. Y si la licencia nunca llegó a
	// activarse no hay `main_device_id` ni socket que cerrar.
	await cerrarSocketsDelDispositivo(
		c.env.TenantHub,
		String(c.env.LICENSE_JWT_SECRET || ""),
		String(lic.tenant_id || ""),
		String(lic.main_device_id || ""),
	);

	return c.json({ ok: true, licenseId, status: "revoked" });
});

/**
 * Deshace una revocación.
 *
 * La operación ya existía (`reactivateLicense`, LIC-07) pero sólo la alcanzaba el cierre de una
 * disputa ganada en el webhook de Stripe. Aquí se expone porque revocar a mano es justo donde se
 * mete la pata —una tecla en el `licenseId` y le cortas el TPV a quien no debías—, y hasta ahora
 * la única salida era emitir otra licencia y hacer pasar al cliente por el cambio de dispositivo.
 *
 * A qué estado vuelve lo decide `reactivateLicense`: `issued` si nunca se activó, `active` si sí.
 * Una caducidad de por medio la resuelve el gate por `expires_at_ms`, aquí no se toca.
 */
adminRoutes.post("/licenses/:id/unrevoke", async (c) => {
	const db = getDb(c.env);
	const licenseId = c.req.param("id");

	const lic = await getLicenseById(db, licenseId);
	if (!lic) return c.json({ ok: false, error: "license_not_found" }, 404);
	if (lic.status !== "revoked") {
		return c.json({ ok: false, error: "license_not_revoked", status: lic.status }, 409);
	}

	await reactivateLicense(db, licenseId);
	// La acción se registra como `reactivate`: es la misma operación que cierra una disputa ganada
	// en Stripe, y tener dos nombres para un mismo hecho parte la auditoría en dos.
	await auditAdmin(db, "reactivate", licenseId, { keyShort: lic.key_short, via: "admin" });

	const despues = await getLicenseById(db, licenseId);
	return c.json({ ok: true, licenseId, status: despues?.status ?? "active" });
});

const extendSchema = z.object({
	months: z.union([z.literal(1), z.literal(3), z.literal(12)], {
		message: `months debe ser ${TERMS.join(" | ")}`,
	}),
});

adminRoutes.post("/licenses/:id/extend", cuerpo(extendSchema), async (c) => {
	const db = getDb(c.env);
	const licenseId = c.req.param("id");
	const { months } = c.req.valid("json");

	const lic = await getLicenseById(db, licenseId);
	if (!lic) return c.json({ ok: false, error: "license_not_found" }, 404);

	const expiresAtMs = await extendLicense(db, licenseId, months);
	await auditAdmin(db, "extend", licenseId, { months, expiresAtMs });

	return c.json({
		ok: true,
		licenseId,
		expiresAt: new Date(expiresAtMs).toISOString(),
	});
});

/**
 * Resta meses a la caducidad. Es el inverso de `extend`, y puede dejar la fecha en el pasado — que
 * es exactamente "caducada", tal y como lo interpreta el gate.
 *
 * Como `unrevoke`, la operación (`shortenLicense`, LIC-07) ya existía para el reembolso de una
 * renovación en Stripe. Se expone por dos motivos: corregir a mano un `extend` de más, y poder
 * comprobar de verdad qué hace la aplicación cuando la licencia caduca — hasta ahora eso no se
 * podía ensayar sin esperar meses.
 *
 * ⚠️ Deja al cliente sin servicio pasada la gracia. No hay confirmación aquí: la protección es que
 * el token de administración no lo tiene nadie más.
 */
const shortenSchema = z.object({
	months: z.number().int().positive().max(120),
});

adminRoutes.post("/licenses/:id/shorten", cuerpo(shortenSchema), async (c) => {
	const db = getDb(c.env);
	const licenseId = c.req.param("id");
	const { months } = c.req.valid("json");

	const lic = await getLicenseById(db, licenseId);
	if (!lic) return c.json({ ok: false, error: "license_not_found" }, 404);

	const expiresAtMs = await shortenLicense(db, licenseId, months);
	if (expiresAtMs === null) {
		// Sin `expires_at_ms` no hay nada que acortar: la licencia no se ha activado todavía, así
		// que su reloj ni siquiera ha arrancado.
		return c.json({ ok: false, error: "license_not_activated" }, 409);
	}

	await auditAdmin(db, "shorten", licenseId, { months, expiresAtMs });

	return c.json({
		ok: true,
		licenseId,
		expiresAt: new Date(expiresAtMs).toISOString(),
		caducada: expiresAtMs < Date.now(),
	});
});

/* ── PROD-06 · Interruptores remotos de emergencia ───────────────────────────────────────────
 *
 *   GET  /v1/admin/interruptores               → los vigentes (y con ?historial=1, los últimos)
 *   POST /v1/admin/interruptores               → apaga uno (global o de un tenant, con caducidad)
 *   POST /v1/admin/interruptores/:id/encender  → lo vuelve a encender antes de su caducidad
 *
 * Encender no borra la fila: le adelanta la caducidad a ahora. Así queda el rastro de qué se
 * apagó, cuándo y por qué, que es lo primero que se pregunta después de un incidente.
 */

const apagarSchema = z.object({
	interruptor: zInterruptor,
	/** Sin tenant = todos los negocios. */
	tenantId: z.string().trim().min(1).max(100).optional(),
	versionDesde: z.string().trim().min(1).max(40).optional(),
	versionHasta: z.string().trim().min(1).max(40).optional(),
	/** Se enseña en la pantalla del TPV: tiene que poder leerlo el dueño del bar. */
	motivo: z.string().trim().min(3).max(300),
	horas: z.number().positive(),
});

adminRoutes.post("/interruptores", cuerpo(apagarSchema), async (c) => {
	const db = getDb(c.env);
	const b = c.req.valid("json");

	const tope = maxHoras(b.interruptor);
	if (b.horas > tope) {
		return c.json(
			{
				ok: false,
				error: "validation_error",
				message: `«${b.interruptor}» se puede apagar como mucho ${tope} h seguidas`,
			},
			400,
		);
	}

	const ahora = Date.now();
	const id = crypto.randomUUID();
	const expiresAtMs = ahora + Math.round(b.horas * 3_600_000);
	const tenantId = b.tenantId ?? TODOS;

	await db.execute({
		sql: `INSERT INTO interruptores
		        (interruptor_id, interruptor, tenant_id, version_desde, version_hasta, motivo,
		         expires_at_ms, created_at_ms)
		      VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
		args: [
			id,
			b.interruptor,
			tenantId,
			b.versionDesde ?? null,
			b.versionHasta ?? null,
			b.motivo,
			expiresAtMs,
			ahora,
		],
	});
	await auditAdmin(db, "interruptor_apagar", null, {
		interruptorId: id,
		interruptor: b.interruptor,
		tenantId,
		versionDesde: b.versionDesde ?? null,
		versionHasta: b.versionHasta ?? null,
		motivo: b.motivo,
		expiresAtMs,
	});
	olvidarInterruptoresCacheados();

	return c.json({
		ok: true,
		interruptorId: id,
		interruptor: b.interruptor,
		tenantId,
		expiresAt: new Date(expiresAtMs).toISOString(),
	});
});

adminRoutes.post("/interruptores/:id/encender", async (c) => {
	const db = getDb(c.env);
	const id = c.req.param("id");
	const ahora = Date.now();

	const rs = await db.execute({
		sql: `UPDATE interruptores SET expires_at_ms = ?
		       WHERE interruptor_id = ? AND expires_at_ms > ?
		   RETURNING interruptor, tenant_id;`,
		args: [ahora, id, ahora],
	});
	const fila = rs.rows?.[0] as any | undefined;
	if (!fila) return c.json({ ok: false, error: "interruptor_not_found" }, 404);

	await auditAdmin(db, "interruptor_encender", null, {
		interruptorId: id,
		interruptor: String(fila.interruptor),
		tenantId: String(fila.tenant_id),
	});
	olvidarInterruptoresCacheados();

	return c.json({ ok: true, interruptorId: id });
});

adminRoutes.get("/interruptores", async (c) => {
	const db = getDb(c.env);
	const ahora = Date.now();
	const historial = c.req.query("historial") === "1";

	const rs = await db.execute({
		sql: historial
			? `SELECT * FROM interruptores ORDER BY created_at_ms DESC LIMIT 50;`
			: `SELECT * FROM interruptores WHERE expires_at_ms > ? ORDER BY created_at_ms DESC;`,
		args: historial ? [] : [ahora],
	});

	return c.json({
		ok: true,
		interruptores: ((rs.rows ?? []) as unknown as FilaInterruptor[]).map((f) => ({
			interruptorId: f.interruptor_id,
			interruptor: f.interruptor,
			tenantId: f.tenant_id,
			versionDesde: f.version_desde,
			versionHasta: f.version_hasta,
			motivo: f.motivo,
			vigente: Number(f.expires_at_ms) > ahora,
			expiresAt: new Date(Number(f.expires_at_ms)).toISOString(),
			createdAt: new Date(Number(f.created_at_ms)).toISOString(),
		})),
	});
});

/* ── Bares piloto y canal beta de actualizaciones (RI-30) ─────────────────────
 *
 * Los equipos de un negocio piloto reciben las versiones del canal `beta` antes que nadie (ver
 * `domains/updates/updates.routes.ts`). Aquí se marca qué negocios lo son y se promociona una versión
 * de `beta` a `stable` cuando ha aguantado unos días en ellos.
 */

/** Cuántos negocios devuelve la lista, como mucho (el techo va en la respuesta). */
const TECHO_NEGOCIOS = 500;

adminRoutes.get("/pilotos", async (c) => {
	const db = getDb(c.env);
	const todos = c.req.query("todos") === "1";
	const rs = await db.execute({
		sql: `
			SELECT tenant_id, display_name, legal_name, piloto
			FROM tenants
			WHERE status <> 'deleted' AND (?1 = 1 OR piloto = 1)
			ORDER BY piloto DESC, display_name
			LIMIT ?2;
		`,
		args: [todos ? 1 : 0, TECHO_NEGOCIOS + 1],
	});
	const filas = (rs.rows ?? []) as any[];
	return c.json({
		ok: true,
		negocios: filas.slice(0, TECHO_NEGOCIOS).map((f) => ({
			tenantId: String(f.tenant_id),
			nombre: f.display_name ?? f.legal_name ?? null,
			piloto: Number(f.piloto) === 1,
		})),
		hayMas: filas.length > TECHO_NEGOCIOS,
	});
});

const pilotoSchema = z.object({
	tenantId: z.string().min(1),
	piloto: z.boolean(),
});

adminRoutes.post("/pilotos", cuerpo(pilotoSchema), async (c) => {
	const { tenantId, piloto } = c.req.valid("json");
	const db = getDb(c.env);
	const r = await db.execute({
		sql: `UPDATE tenants SET piloto = ?, updated_at_ms = ? WHERE tenant_id = ?;`,
		args: [piloto ? 1 : 0, Date.now(), tenantId],
	});
	if (Number((r as any)?.rowsAffected ?? 0) === 0) {
		return c.json({ ok: false, error: "not_found", message: "No hay ningún negocio con ese id." }, 404);
	}
	await auditAdmin(db, piloto ? "piloto_poner" : "piloto_quitar", null, { tenantId });
	return c.json({ ok: true, tenantId, piloto });
});

/** Las últimas versiones publicadas, con su canal: lo que hace falta para decidir qué promocionar. */
adminRoutes.get("/releases", async (c) => {
	const db = getDb(c.env);
	const rs = await db.execute(`
		SELECT version, target, arch, channel, is_active, pub_date
		FROM app_releases
		ORDER BY created_at_ms DESC
		LIMIT 50;
	`);
	return c.json({
		ok: true,
		releases: ((rs.rows ?? []) as any[]).map((f) => ({
			version: String(f.version),
			target: String(f.target),
			arch: String(f.arch),
			canal: String(f.channel),
			activa: Number(f.is_active) === 1,
			publicada: String(f.pub_date),
		})),
	});
});

const promocionarSchema = z.object({
	version: z.string().min(1),
	target: z.string().optional(),
	arch: z.string().optional(),
});

/**
 * Promociona una versión de `beta` a `stable`: la copia al canal estable con la misma firma y URL, y
 * desde ese momento se la ofrece el feed a todos los equipos. Sin `arch`, en todos los que tenga.
 */
adminRoutes.post("/releases/promote", cuerpo(promocionarSchema), async (c) => {
	const { version, target, arch } = c.req.valid("json");
	const db = getDb(c.env);
	// El `WHERE` del SELECT no sobra: sin él, SQLite no sabe si el `ON` es de un JOIN o del upsert.
	const r = await db.execute({
		sql: `
			INSERT INTO app_releases
				(version, target, arch, channel, notes, pub_date, signature, url, is_active, created_at_ms)
			SELECT version, target, arch, 'stable', notes, pub_date, signature, url, 1, unixepoch()*1000
			FROM app_releases
			WHERE version = ?1 AND target = ?2 AND channel = 'beta' AND is_active = 1
			  AND (?3 IS NULL OR arch = ?3)
			ON CONFLICT(version, target, arch, channel) DO UPDATE SET
				notes = excluded.notes,
				pub_date = excluded.pub_date,
				signature = excluded.signature,
				url = excluded.url,
				is_active = 1;
		`,
		args: [version, target || "windows", arch ?? null],
	});
	if (Number((r as any)?.rowsAffected ?? 0) === 0) {
		return c.json(
			{ ok: false, error: "not_found", message: "Esa versión no está activa en el canal beta." },
			404,
		);
	}
	await auditAdmin(db, "release_promocionar", null, { version, target: target || "windows", arch: arch ?? "todos" });
	return c.json({ ok: true, version });
});
