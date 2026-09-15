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
import { aesGcmDecrypt, aesGcmEncrypt } from "./crypto";
import { generateLicenseKey, licenseKeyHash, licenseKeyShort } from "../domains/licensing/licenseKey";
import { exec } from "./db";

/* ============================================================
   Auto-provisión del esquema (control-plane)
============================================================ */

let schemaReady = false;

/**
 * Crea las tablas del sistema de licencias si no existen. Se ejecuta una vez por isolate (patrón
 * de `updates.routes.ts`): así no hace falta ni migración ni script manual.
 *
 * ⚠️ La única cosa que esto NO puede hacer es **recrear** una tabla `licenses` que ya exista con
 * el esquema viejo de Lemon (`CREATE TABLE IF NOT EXISTS` no la reemplaza). En un entorno que
 * venga de Lemon hay que borrarla una vez: `DROP TABLE licenses;` — y el worker la reconstruye.
 */
export async function ensureLicensingSchema(db: Client): Promise<void> {
	if (schemaReady) return;

	await exec(
		db,
		`
    CREATE TABLE IF NOT EXISTS licenses (
      license_id                 TEXT PRIMARY KEY,
      license_key_hash           TEXT NOT NULL UNIQUE,
      license_key_enc            TEXT,
      key_short                  TEXT,
      tenant_id                  TEXT,
      main_device_id             TEXT,
      status                     TEXT NOT NULL,
      disabled                   INTEGER NOT NULL DEFAULT 0,
      plan                       TEXT NOT NULL DEFAULT 'standard',
      term_months                INTEGER NOT NULL,
      origin                     TEXT NOT NULL,
      issued_at_ms               INTEGER NOT NULL,
      activated_at_ms            INTEGER,
      expires_at_ms              INTEGER,
      customer_email             TEXT NOT NULL,
      customer_name              TEXT,
      customer_business_name     TEXT,
      customer_phone             TEXT,
      customer_address_json      TEXT,
      key_email_sent_at_ms       INTEGER,
      stripe_customer_id         TEXT,
      stripe_checkout_session_id TEXT,
      stripe_payment_intent_id   TEXT,
      stripe_price_id            TEXT,
      created_at_ms              INTEGER NOT NULL,
      updated_at_ms              INTEGER NOT NULL
    );
    `,
	);

	// Índice único de idempotencia del fulfillment de Stripe (parcial: ignora los NULL).
	await exec(
		db,
		`CREATE UNIQUE INDEX IF NOT EXISTS ux_licenses_stripe_session
       ON licenses (stripe_checkout_session_id) WHERE stripe_checkout_session_id IS NOT NULL;`,
	);
	await exec(db, `CREATE INDEX IF NOT EXISTS ix_licenses_stripe_customer ON licenses (stripe_customer_id);`);
	await exec(db, `CREATE INDEX IF NOT EXISTS ix_licenses_tenant ON licenses (tenant_id);`);
	await exec(db, `CREATE INDEX IF NOT EXISTS ix_licenses_email ON licenses (customer_email);`);

	await exec(
		db,
		`
    CREATE TABLE IF NOT EXISTS license_device_otp (
      license_id     TEXT NOT NULL,
      new_device_id  TEXT NOT NULL,
      code_hash      TEXT NOT NULL,
      attempts       INTEGER NOT NULL DEFAULT 0,
      expires_at_ms  INTEGER NOT NULL,
      consumed_at_ms INTEGER,
      created_at_ms  INTEGER NOT NULL,
      PRIMARY KEY (license_id, new_device_id)
    );
    `,
	);

	// Códigos de un solo uso que se mandan por correo desde una ruta de tenant: recuperar el PIN
	// (LOGIN-07) y confirmar un correo de recuperación nuevo (LOGIN-08). Uno por equipo y propósito
	// —no por usuario ni por dirección—, para que el tope de envíos no se multiplique recorriendo ids
	// o direcciones. Ver `domains/login/codigosPorCorreo.ts`.
	await exec(
		db,
		`
    CREATE TABLE IF NOT EXISTS email_codes (
      tenant_id         TEXT NOT NULL,
      device_id         TEXT NOT NULL,
      purpose           TEXT NOT NULL,
      subject           TEXT NOT NULL,
      code_hash         TEXT NOT NULL,
      attempts          INTEGER NOT NULL DEFAULT 0,
      expires_at_ms     INTEGER NOT NULL,
      consumed_at_ms    INTEGER,
      created_at_ms     INTEGER NOT NULL,
      sends_in_window   INTEGER NOT NULL DEFAULT 1,
      window_started_ms INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, device_id, purpose)
    );
    `,
	);

	// LOGIN-08: a dónde llegan los códigos de recuperación, cuando no es al correo de la compra.
	// Sin fila = el de la compra. Tabla propia y no una columna de `tenants`, que ya tenía un `email`
	// escrito a mano al activar y sin verificar: así nunca hay que decidir si ése vale.
	await exec(
		db,
		`
    CREATE TABLE IF NOT EXISTS tenant_recovery_emails (
      tenant_id      TEXT PRIMARY KEY,
      email          TEXT NOT NULL,
      verified_at_ms INTEGER NOT NULL
    );
    `,
	);

	await exec(
		db,
		`
    CREATE TABLE IF NOT EXISTS license_device_swaps (
      swap_id        TEXT PRIMARY KEY,
      license_id     TEXT NOT NULL,
      from_device_id TEXT,
      to_device_id   TEXT NOT NULL,
      at_ms          INTEGER NOT NULL
    );
    `,
	);

	await exec(
		db,
		`
    CREATE TABLE IF NOT EXISTS admin_audit (
      audit_id   TEXT PRIMARY KEY,
      action     TEXT NOT NULL,
      license_id TEXT,
      detail     TEXT,
      at_ms      INTEGER NOT NULL
    );
    `,
	);

	// LIC-07: historial de cobros. `licenses` solo guarda el ÚLTIMO (`attachStripeSession`
	// sobrescribe en cada renovación), así que sin esto un reembolso no se puede atribuir: no hay
	// forma de saber si el cargo devuelto fue el alta o una renovación, ni cuántos meses aportó.
	// `reversed_*` deja constancia de la devolución y hace idempotente su aplicación.
	await exec(
		db,
		`
    CREATE TABLE IF NOT EXISTS license_payments (
      payment_id                 TEXT PRIMARY KEY,
      license_id                 TEXT NOT NULL,
      kind                       TEXT NOT NULL,
      term_months                INTEGER NOT NULL,
      stripe_checkout_session_id TEXT,
      stripe_payment_intent_id   TEXT,
      reversed_at_ms             INTEGER,
      reversed_reason            TEXT,
      reversed_event_uid         TEXT,
      at_ms                      INTEGER NOT NULL
    );
    `,
	);
	await exec(
		db,
		`CREATE INDEX IF NOT EXISTS ix_license_payments_intent
       ON license_payments (stripe_payment_intent_id);`,
	);
	await exec(
		db,
		`CREATE INDEX IF NOT EXISTS ix_license_payments_license ON license_payments (license_id);`,
	);

	// Datos del negocio en `tenants` (corrige el bug #5). ALTER no admite IF NOT EXISTS: si la
	// columna ya está, Turso lanza "duplicate column name" y lo ignoramos.
	// TRAB-03: DEK del tenant para cifrar la PII del personal (DNI/IBAN/nº SS). Se guarda
	// CIFRADA con LICENSE_STORE_KEY, que es un secreto del worker y no vive en esta BD: un
	// volcado del control-plane no basta para descifrar los datos del personal.
	for (const col of ["display_name", "legal_name", "email", "phone", "country", "field_dek"]) {
		try {
			await exec(db, `ALTER TABLE tenants ADD COLUMN ${col} TEXT;`);
		} catch {
			/* columna ya existente */
		}
	}

	// Datos de compra de Stripe (nombre empresarial, teléfono, dirección de facturación) para la
	// factura que el negocio emite luego a mano. Auto-añadidos a una tabla `licenses` ya existente
	// (el CREATE TABLE IF NOT EXISTS de arriba solo sirve para BBDD nuevas).
	for (const col of ["customer_business_name", "customer_phone", "customer_address_json"]) {
		try {
			await exec(db, `ALTER TABLE licenses ADD COLUMN ${col} TEXT;`);
		} catch {
			/* columna ya existente */
		}
	}

	// Entrega del correo con la clave: `key_email_sent_at_ms IS NULL` ⇒ ese cliente pagó y NO ha
	// recibido su clave (fallo de email). INTEGER, aparte del bucle de arriba que crea columnas TEXT.
	try {
		await exec(db, `ALTER TABLE licenses ADD COLUMN key_email_sent_at_ms INTEGER;`);
	} catch {
		/* columna ya existente */
	}

	schemaReady = true;
}

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
	customer_business_name: string | null;
	customer_phone: string | null;
	customer_address_json: string | null;
	key_email_sent_at_ms: number | null;

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
	customerBusinessName?: string | null;
	customerPhone?: string | null;
	customerAddressJson?: string | null;
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
      customer_business_name, customer_phone, customer_address_json,
      stripe_customer_id, stripe_checkout_session_id, stripe_payment_intent_id, stripe_price_id,
      created_at_ms, updated_at_ms
    ) VALUES (
      ?, ?, ?, ?,
      NULL, NULL,
      'issued', 0,
      ?, ?, ?,
      ?, NULL, NULL,
      ?, ?,
      ?, ?, ?,
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
			args.customerBusinessName ?? null,
			args.customerPhone ?? null,
			args.customerAddressJson ?? null,
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

/**
 * LIC-07: deshace una revocación. Solo la usa el cierre de una disputa GANADA: el dinero vuelve,
 * así que cortar el servicio deja de tener motivo.
 *
 * El estado al que regresa depende de si la licencia llegó a activarse: una que nunca se activó
 * vuelve a `issued` (su reloj no había arrancado) y una activada a `active`. Si además caducó
 * mientras tanto, `computeLicenseState` ya lo resuelve por `expires_at_ms`: aquí no se toca.
 */
export async function reactivateLicense(db: Client, licenseId: string): Promise<void> {
	const now = Date.now();
	await exec(
		db,
		`
    UPDATE licenses
    SET status = CASE WHEN activated_at_ms IS NULL THEN 'issued' ELSE 'active' END,
        disabled = 0,
        updated_at_ms = ?
    WHERE license_id = ? AND status = 'revoked';
    `,
		[now, licenseId],
	);
}

/**
 * LIC-07: resta meses a la caducidad (reembolso de una renovación). Es el inverso de
 * `extendLicense`: se quitan los meses que aportó ese cobro y la licencia vuelve a la fecha que
 * tenía antes, sin tocar el periodo que el cliente sí pagó y usó.
 *
 * Puede dejar `expires_at_ms` en el pasado (renovación anticipada y devuelta): eso es
 * exactamente "caducada", y el gate ya lo interpreta así.
 */
export async function shortenLicense(
	db: Client,
	licenseId: string,
	months: number,
): Promise<number | null> {
	const lic = await getLicenseById(db, licenseId);
	if (!lic || lic.expires_at_ms == null) return null;

	const expiresAt = addMonths(lic.expires_at_ms, -months);
	await exec(
		db,
		`UPDATE licenses SET expires_at_ms=?, updated_at_ms=? WHERE license_id=?;`,
		[expiresAt, Date.now(), licenseId],
	);

	return expiresAt;
}

export type LicensePaymentKind = "issue" | "renewal";

export type LicensePaymentRow = {
	payment_id: string;
	license_id: string;
	kind: LicensePaymentKind;
	term_months: number;
	stripe_checkout_session_id: string | null;
	stripe_payment_intent_id: string | null;
	reversed_at_ms: number | null;
	reversed_reason: string | null;
	reversed_event_uid: string | null;
	at_ms: number;
};

/** LIC-07: registra un cobro cumplido (alta o renovación) para poder revertirlo después. */
export async function recordLicensePayment(
	db: Client,
	args: {
		licenseId: string;
		kind: LicensePaymentKind;
		termMonths: number;
		sessionId: string | null;
		paymentIntentId: string | null;
	},
): Promise<void> {
	await exec(
		db,
		`
    INSERT INTO license_payments
      (payment_id, license_id, kind, term_months, stripe_checkout_session_id,
       stripe_payment_intent_id, at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?);
    `,
		[
			crypto.randomUUID(),
			args.licenseId,
			args.kind,
			args.termMonths,
			args.sessionId,
			args.paymentIntentId,
			Date.now(),
		],
	);
}

/** LIC-07: el cobro al que apunta un cargo de Stripe (por su PaymentIntent). */
export async function getLicensePaymentByIntent(
	db: Client,
	paymentIntentId: string,
): Promise<LicensePaymentRow | null> {
	const r = await exec(
		db,
		`
    SELECT * FROM license_payments
    WHERE stripe_payment_intent_id = ?
    ORDER BY at_ms DESC
    LIMIT 1;
    `,
		[paymentIntentId],
	);
	return (r.rows?.[0] as unknown as LicensePaymentRow) ?? null;
}

/** LIC-07: marca un cobro como devuelto. Impide que dos eventos de Stripe lo reviertan dos veces. */
export async function markLicensePaymentReversed(
	db: Client,
	paymentId: string,
	args: { reason: string; eventUid: string },
): Promise<void> {
	await exec(
		db,
		`
    UPDATE license_payments
    SET reversed_at_ms=?, reversed_reason=?, reversed_event_uid=?
    WHERE payment_id=? AND reversed_at_ms IS NULL;
    `,
		[Date.now(), args.reason, args.eventUid, paymentId],
	);
}

/**
 * LIC-07: deshace la marca de devolución (disputa ganada). Sin esto el cobro quedaría marcado
 * como revertido para siempre y un reembolso posterior del mismo cargo no haría nada.
 */
export async function clearLicensePaymentReversal(
	db: Client,
	paymentId: string,
): Promise<void> {
	await exec(
		db,
		`
    UPDATE license_payments
    SET reversed_at_ms=NULL, reversed_reason=NULL, reversed_event_uid=NULL
    WHERE payment_id=?;
    `,
		[paymentId],
	);
}

/**
 * LIC-07: la única licencia de un cliente de Stripe, o `null` si no hay exactamente una.
 *
 * Último recurso para atribuir un reembolso cuyo cargo no está en `license_payments` (una
 * licencia anterior a esa tabla). Se exige unicidad a propósito: revocar a ojo la licencia
 * equivocada de un cliente con varias sería peor que no hacer nada y avisar.
 */
export async function getSoleLicenseByStripeCustomer(
	db: Client,
	stripeCustomerId: string,
): Promise<LicenseRow | null> {
	const r = await exec(
		db,
		`SELECT * FROM licenses WHERE stripe_customer_id = ? LIMIT 2;`,
		[stripeCustomerId],
	);
	const filas = (r.rows ?? []) as unknown as LicenseRow[];
	return filas.length === 1 ? filas[0] : null;
}

/** LIC-07: la licencia sellada con ese PaymentIntent (el último cobro que la tocó). */
export async function getLicenseByStripeIntent(
	db: Client,
	paymentIntentId: string,
): Promise<LicenseRow | null> {
	const r = await exec(
		db,
		`SELECT * FROM licenses WHERE stripe_payment_intent_id = ? LIMIT 1;`,
		[paymentIntentId],
	);
	return (r.rows?.[0] as unknown as LicenseRow) ?? null;
}

/**
 * Marca que el correo con la clave se entregó. Se llama SOLO si el envío devolvió `true`; si falla,
 * la columna queda NULL y ese cliente aparece como "pagó y no tiene su clave" (reenviable con
 * `pnpm license:resend`).
 */
export async function markKeyEmailSent(db: Client, licenseId: string): Promise<void> {
	const now = Date.now();
	await exec(
		db,
		`UPDATE licenses SET key_email_sent_at_ms=?, updated_at_ms=? WHERE license_id=?;`,
		[now, now, licenseId],
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
   DEK de cifrado de campo del tenant (TRAB-03)
============================================================ */

/**
 * Devuelve la DEK del tenant en base64 (texto claro, para entregársela al cliente),
 * creándola la primera vez.
 *
 * En reposo se guarda cifrada con `LICENSE_STORE_KEY`. El worker NO usa esta clave para
 * nada más: no descifra datos del personal, sólo la custodia para poder devolvérsela al
 * cliente cuando cambie de equipo, que es lo que evita que el cliente tenga que apuntarse
 * un código de recuperación.
 */
export async function getOrCreateTenantFieldDek(
	db: Client,
	storeKeyB64: string,
	tenantId: string,
): Promise<string> {
	const existente = await leerFieldDek(db, storeKeyB64, tenantId);
	if (existente) return existente;

	const bytes = crypto.getRandomValues(new Uint8Array(32));
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	const dekB64 = btoa(bin);

	const cifrada = await aesGcmEncrypt(storeKeyB64, dekB64);

	// Guarda condicionalmente: si dos activaciones del mismo tenant corren a la vez, sólo
	// una escribe. La perdedora relee y usa la del ganador — dos DEKs distintas para el mismo
	// tenant dejarían la mitad de las filas indescifrables.
	const res = await db.execute({
		sql: `
    UPDATE tenants
    SET field_dek=?, updated_at_ms=?
    WHERE tenant_id=? AND (field_dek IS NULL OR field_dek='');
    `,
		args: [cifrada, Date.now(), tenantId],
	});

	const escribio = Number((res as any)?.rowsAffected ?? 0) > 0;
	if (escribio) return dekB64;

	const ganadora = await leerFieldDek(db, storeKeyB64, tenantId);
	if (!ganadora) throw new Error("field_dek_no_persistida");
	return ganadora;
}

async function leerFieldDek(
	db: Client,
	storeKeyB64: string,
	tenantId: string,
): Promise<string | null> {
	const r = await db.execute({
		sql: `SELECT field_dek FROM tenants WHERE tenant_id=? LIMIT 1;`,
		args: [tenantId],
	});

	const guardada = String((r.rows?.[0] as any)?.field_dek ?? "").trim();
	if (!guardada) return null;

	return await aesGcmDecrypt(storeKeyB64, guardada);
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
   Códigos por correo de las rutas de tenant (LOGIN-07 / LOGIN-08)
============================================================ */

export type EmailCodePurpose = "recuperar_pin" | "cambio_correo";

/** Un código es de un equipo y un propósito: pedir otro del mismo sustituye al anterior. */
export type EmailCodeKey = { tenantId: string; deviceId: string; purpose: EmailCodePurpose };

export type EmailCodeRow = {
	tenant_id: string;
	device_id: string;
	purpose: EmailCodePurpose;
	/** A qué se refiere: el usuario del PIN, o la dirección nueva del cambio de correo. */
	subject: string;
	code_hash: string;
	attempts: number;
	expires_at_ms: number;
	consumed_at_ms: number | null;
	created_at_ms: number;
	sends_in_window: number;
	window_started_ms: number;
};

export async function getEmailCode(db: Client, k: EmailCodeKey): Promise<EmailCodeRow | null> {
	const r = await exec(
		db,
		`SELECT * FROM email_codes WHERE tenant_id=? AND device_id=? AND purpose=? LIMIT 1;`,
		[k.tenantId, k.deviceId, k.purpose],
	);
	const row = r.rows?.[0] as any;
	if (!row) return null;
	return {
		tenant_id: String(row.tenant_id),
		device_id: String(row.device_id),
		purpose: String(row.purpose) as EmailCodePurpose,
		subject: String(row.subject),
		code_hash: String(row.code_hash),
		attempts: Number(row.attempts ?? 0),
		expires_at_ms: Number(row.expires_at_ms ?? 0),
		consumed_at_ms: row.consumed_at_ms == null ? null : Number(row.consumed_at_ms),
		created_at_ms: Number(row.created_at_ms ?? 0),
		sends_in_window: Number(row.sends_in_window ?? 0),
		window_started_ms: Number(row.window_started_ms ?? 0),
	};
}

/** Guarda el código (sólo su HMAC). Pedir otro sustituye al anterior y reinicia los intentos. */
export async function putEmailCode(
	db: Client,
	args: EmailCodeKey & {
		subject: string;
		codeHash: string;
		expiresAtMs: number;
		nowMs: number;
		sendsInWindow: number;
		windowStartedMs: number;
	},
): Promise<void> {
	await exec(
		db,
		`
    INSERT INTO email_codes (
      tenant_id, device_id, purpose, subject, code_hash, attempts, expires_at_ms, consumed_at_ms,
      created_at_ms, sends_in_window, window_started_ms
    ) VALUES (?, ?, ?, ?, ?, 0, ?, NULL, ?, ?, ?)
    ON CONFLICT(tenant_id, device_id, purpose) DO UPDATE SET
      subject=excluded.subject,
      code_hash=excluded.code_hash,
      attempts=0,
      expires_at_ms=excluded.expires_at_ms,
      consumed_at_ms=NULL,
      created_at_ms=excluded.created_at_ms,
      sends_in_window=excluded.sends_in_window,
      window_started_ms=excluded.window_started_ms;
    `,
		[
			args.tenantId,
			args.deviceId,
			args.purpose,
			args.subject,
			args.codeHash,
			args.expiresAtMs,
			args.nowMs,
			args.sendsInWindow,
			args.windowStartedMs,
		],
	);
}

/**
 * Reserva un intento ANTES de comparar el código, en una sola sentencia: devuelve el número de
 * intento reservado, o `null` si ya no quedan (o el código está consumido). Comprobar primero y
 * sumar después dejaría pasar a la vez a todas las peticiones concurrentes.
 */
export async function reserveEmailCodeAttempt(
	db: Client,
	k: EmailCodeKey,
	maxAttempts: number,
): Promise<number | null> {
	const r = await exec(
		db,
		`
    UPDATE email_codes
    SET attempts = attempts + 1
    WHERE tenant_id=? AND device_id=? AND purpose=? AND consumed_at_ms IS NULL AND attempts < ?
    RETURNING attempts;
    `,
		[k.tenantId, k.deviceId, k.purpose, maxAttempts],
	);
	const row = r.rows?.[0] as any;
	return row ? Number(row.attempts) : null;
}

/** Consumo atómico: sólo consume si sigue sin consumir. */
export async function consumeEmailCode(db: Client, k: EmailCodeKey, nowMs: number): Promise<boolean> {
	const r = await exec(
		db,
		`
    UPDATE email_codes
    SET consumed_at_ms = ?
    WHERE tenant_id=? AND device_id=? AND purpose=? AND consumed_at_ms IS NULL
    RETURNING tenant_id;
    `,
		[nowMs, k.tenantId, k.deviceId, k.purpose],
	);
	return (r.rows?.length ?? 0) > 0;
}

/** Deja el código inservible sin borrar la fila: el tope de envíos por hora vive en ella. */
export async function voidEmailCode(db: Client, k: EmailCodeKey, nowMs: number): Promise<void> {
	await exec(
		db,
		`UPDATE email_codes SET consumed_at_ms=? WHERE tenant_id=? AND device_id=? AND purpose=?;`,
		[nowMs, k.tenantId, k.deviceId, k.purpose],
	);
}

/* ============================================================
   Correo de recuperación del tenant (LOGIN-08)
============================================================ */

/** El correo propio, o `null` si no se ha cambiado (y entonces vale el de la compra). */
export async function getTenantRecoveryEmail(db: Client, tenantId: string): Promise<string | null> {
	const r = await exec(
		db,
		`SELECT email FROM tenant_recovery_emails WHERE tenant_id=? LIMIT 1;`,
		[tenantId],
	);
	const email = String((r.rows?.[0] as any)?.email ?? "").trim();
	return email || null;
}

/** `null` vuelve al de la compra (borra la fila). Sólo se llama tras verificar el buzón nuevo. */
export async function setTenantRecoveryEmail(
	db: Client,
	tenantId: string,
	email: string | null,
	nowMs: number,
): Promise<void> {
	if (email === null) {
		await exec(db, `DELETE FROM tenant_recovery_emails WHERE tenant_id=?;`, [tenantId]);
		return;
	}
	await exec(
		db,
		`
    INSERT INTO tenant_recovery_emails (tenant_id, email, verified_at_ms)
    VALUES (?, ?, ?)
    ON CONFLICT(tenant_id) DO UPDATE SET
      email=excluded.email,
      verified_at_ms=excluded.verified_at_ms;
    `,
		[tenantId, email, nowMs],
	);
}

/* ============================================================
   Dispositivos (anti-copia por pubkey ed25519)
============================================================ */

/**
 * Pubkey del dispositivo **sin mirar la revocación**, a diferencia del resto del worker
 * (ver `lib/deviceAuth.ts`). La usan el device-proof de `/v1/license/status` y `/refresh`,
 * que son el gate de licencia: un equipo revocado tiene que poder seguir preguntando en qué
 * estado está su licencia — si también se le cerrara esta puerta, el cliente vería un fallo
 * de red, entraría en gracia offline y acabaría bloqueado sin saber por qué. La asimetría es
 * deliberada; quien la unifique con el criterio general está cambiando eso a propósito.
 */
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

/**
 * Alta o readmisión del dispositivo. La llama `/v1/license/activate`, es decir: alguien ha
 * presentado una clave de licencia válida (y el OTP al email del titular si era un cambio de
 * equipo). Eso **es** la autorización, así que la fila queda como la de un dispositivo vivo.
 *
 * ⚠️ `revoked_at_ms=NULL` no sobra. La PK de `devices` es el `device_id`, que en el cliente
 * vive en el keyring del SO y sobrevive a reinstalar la app, borrar AppData y cambiar de
 * licencia y de tenant. Sin esta línea, una revocación vieja —por ejemplo la de cuando ese
 * mismo equipo se desvinculó siendo Handy— seguía en la fila para siempre: el dispositivo
 * activaba bien, pasaba `/v1/license/status` y fallaba con 401 en TODO lo demás, sin que el
 * cliente pudiera hacer nada desde su lado. Aprobar un pairing ya normaliza la columna igual
 * (ver `pairApprove`); activar tenía que hacerlo también.
 */
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
    INSERT INTO devices (device_id, tenant_id, role, first_seen_at_ms, last_seen_at_ms, revoked_at_ms)
    VALUES (?, ?, ?, ?, ?, NULL)
    ON CONFLICT(device_id) DO UPDATE SET
      tenant_id=excluded.tenant_id,
      role=excluded.role,
      last_seen_at_ms=excluded.last_seen_at_ms,
      revoked_at_ms=NULL;
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
	action: "issue" | "revoke" | "extend" | "resend" | "refund" | "dispute" | "reactivate" | "shorten",
	licenseId: string | null,
	detail: Record<string, unknown>,
) {
	await exec(
		db,
		`INSERT INTO admin_audit (audit_id, action, license_id, detail, at_ms) VALUES (?, ?, ?, ?, ?);`,
		[crypto.randomUUID(), action, licenseId, JSON.stringify(detail), Date.now()],
	);
}
