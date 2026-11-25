// src/server/central/operaciones/licencias.ts
//
// Lo que varias operaciones de la central (`registro.ts`) hacen con una licencia, sin esperas: leerla,
// sumarle o restarle meses, anularla y desanularla. Corre dentro de la transacción de la operación
// que lo llama.
//
// Y las sentencias que el Worker también ejecuta sueltas: leer una licencia por su id, darla de alta,
// apuntar en la auditoría y dar de alta el negocio y el equipo. Su texto y sus argumentos salen de aquí, y `server/licenseStore.ts` los
// importa, para que lo que se escribe dentro y fuera de una operación no pueda divergir.

import { toBool01 } from "../../../lib/booleanos";
import type { SqlSync, Valor } from "../../../lib/sql";
import type { LicenseOrigin } from "../../../shared";
import type { LicenseRow } from "../../licenseStore";

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
   Sentencias que también ejecuta el Worker
============================================================ */

/** Una licencia por su id. */
export const LICENCIA_POR_ID = `SELECT * FROM licenses WHERE license_id = ? LIMIT 1;`;

/**
 * El alta de una licencia sin estrenar: `status = 'issued'` y sin caducidad. El reloj no arranca en
 * la compra, sino en la 1ª activación (decisión §4.1 — "compra la clave y actívala cuando montes el
 * TPV").
 */
export const INSERTAR_LICENCIA = `
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
    `;

/**
 * Lo que lleva una licencia nueva. La clave ya viene preparada (`claveNueva` en
 * `server/licenseStore.ts`): su huella, su forma corta y su cifrado. En claro no se guarda nunca.
 */
export type LicenciaNueva = {
	licenseId: string;
	licHash: string;
	keyEnc: string;
	keyShort: string;
	termMonths: number;
	origin: LicenseOrigin;
	plan?: string;
	customerEmail: string;
	customerName?: string | null;
	customerBusinessName?: string | null;
	customerPhone?: string | null;
	customerAddressJson?: string | null;
	stripeCustomerId?: string | null;
	stripeCheckoutSessionId?: string | null;
	stripePaymentIntentId?: string | null;
	stripePriceId?: string | null;
	ahoraMs: number;
};

/** Los argumentos de `INSERTAR_LICENCIA`, en su orden. */
export function argumentosDeLaLicenciaNueva(l: LicenciaNueva): Valor[] {
	return [
		l.licenseId,
		l.licHash,
		l.keyEnc,
		l.keyShort,
		l.plan ?? "standard",
		l.termMonths,
		l.origin,
		l.ahoraMs,
		l.customerEmail,
		l.customerName ?? null,
		l.customerBusinessName ?? null,
		l.customerPhone ?? null,
		l.customerAddressJson ?? null,
		l.stripeCustomerId ?? null,
		l.stripeCheckoutSessionId ?? null,
		l.stripePaymentIntentId ?? null,
		l.stripePriceId ?? null,
		l.ahoraMs,
		l.ahoraMs,
	];
}

/** Una entrada de `admin_audit`. */
export const INSERTAR_AUDITORIA = `INSERT INTO admin_audit (audit_id, action, license_id, detail, at_ms) VALUES (?, ?, ?, ?, ?);`;

/** Los argumentos de `INSERTAR_AUDITORIA`, en su orden. El detalle se guarda como JSON. */
export function argumentosDeLaAuditoria(a: {
	auditId: string;
	accion: string;
	licenseId: string | null;
	detalle: Record<string, unknown>;
	ahoraMs: number;
}): Valor[] {
	return [a.auditId, a.accion, a.licenseId, JSON.stringify(a.detalle), a.ahoraMs];
}

/**
 * El alta del negocio: su fila de `tenants`, o sólo su `updated_at_ms` si ya la tiene. La ejecutan
 * `ensureTenantExistsMinimal` y el traslado (`operaciones/traslado.ts`).
 */
export const ALTA_DEL_NEGOCIO = `
    INSERT INTO tenants (tenant_id, status, created_at_ms, updated_at_ms)
    VALUES (?, 'active', ?, ?)
    ON CONFLICT(tenant_id) DO UPDATE SET
      updated_at_ms=excluded.updated_at_ms;
    `;

/** Los argumentos de `ALTA_DEL_NEGOCIO`, en su orden. */
export function argumentosDelAltaDelNegocio(tenantId: string, ahoraMs: number): Valor[] {
	return [tenantId, ahoraMs, ahoraMs];
}

/**
 * El alta o la readmisión de un equipo, **con su clave y en una sola sentencia**. La ejecutan
 * `ensureDevice` (la primera activación, el mismo equipo, `readmitirMain`) y el traslado
 * (`operaciones/traslado.ts`).
 *
 * AUD-01: la fila nace con su clave, y una que ya existe sólo se toca si su clave registrada es ésta
 * (el `WHERE` del `DO UPDATE`). Si existe con otra clave, o sin ninguna, no escribe nada
 * (`rowsAffected` 0), y quien la ejecuta lo da por `device_key_mismatch`.
 *
 * `revoked_at_ms=NULL` no sobra: el `device_id` sobrevive a reinstalar la app y a cambiar de
 * licencia, y sin esa línea una revocación vieja seguiría en la fila (ver `ensureDevice`).
 */
export const ALTA_DEL_EQUIPO = `
    INSERT INTO devices (
      device_id, tenant_id, role, first_seen_at_ms, last_seen_at_ms, revoked_at_ms,
      device_pubkey_b64, pubkey_alg
    )
    VALUES (?, ?, ?, ?, ?, NULL, ?, 'ed25519')
    ON CONFLICT(device_id) DO UPDATE SET
      tenant_id=excluded.tenant_id,
      role=excluded.role,
      last_seen_at_ms=excluded.last_seen_at_ms,
      revoked_at_ms=NULL
    WHERE devices.device_pubkey_b64 = excluded.device_pubkey_b64;
    `;

/** Los argumentos de `ALTA_DEL_EQUIPO`, en su orden. La clave va recortada. */
export function argumentosDelAltaDelEquipo(e: {
	deviceId: string;
	tenantId: string;
	rol: "tpv" | "handy";
	devicePubKeyB64: string;
	ahoraMs: number;
}): Valor[] {
	return [e.deviceId, e.tenantId, e.rol, e.ahoraMs, e.ahoraMs, e.devicePubKeyB64.trim()];
}

/* ============================================================
   Lo que comparten las operaciones
============================================================ */

/** La licencia `licenseId`, o `null`. */
export function leerLicencia(sql: SqlSync, licenseId: string): LicenseRow | null {
	const r = sql.execute({ sql: LICENCIA_POR_ID, args: [licenseId] });
	return (r.rows[0] as unknown as LicenseRow | undefined) ?? null;
}

/**
 * Extiende la licencia. Si aún no ha caducado, suma sobre `expires_at_ms` (no se pierde lo
 * que quedaba); si ya venció (o nunca se activó), cuenta desde ahora.
 */
export function extendLicense(sql: SqlSync, licenseId: string, months: number, ahoraMs: number): number {
	const lic = leerLicencia(sql, licenseId);
	if (!lic) throw new Error("license_not_found");

	const base = lic.expires_at_ms && lic.expires_at_ms > ahoraMs ? lic.expires_at_ms : ahoraMs;
	const expiresAt = addMonths(base, months);

	sql.execute({
		sql: `
    UPDATE licenses
    SET expires_at_ms=?,
        status = CASE WHEN status='expired' THEN 'active' ELSE status END,
        updated_at_ms=?
    WHERE license_id=?;
    `,
		args: [expiresAt, ahoraMs, licenseId],
	});

	return expiresAt;
}

/**
 * LIC-07: resta meses a la caducidad (reembolso de una renovación). Es el inverso de
 * `extendLicense`: se quitan los meses que aportó ese cobro y la licencia vuelve a la fecha que
 * tenía antes, sin tocar el periodo que el cliente sí pagó y usó.
 *
 * Puede dejar `expires_at_ms` en el pasado (renovación anticipada y devuelta): eso es
 * exactamente "caducada", y el gate ya lo interpreta así. `null` si la licencia no tiene caducidad
 * (no se ha activado): no hay nada que acortar.
 */
export function shortenLicense(sql: SqlSync, licenseId: string, months: number, ahoraMs: number): number | null {
	const lic = leerLicencia(sql, licenseId);
	if (!lic || lic.expires_at_ms == null) return null;

	const expiresAt = addMonths(lic.expires_at_ms, -months);
	sql.execute({
		sql: `UPDATE licenses SET expires_at_ms=?, updated_at_ms=? WHERE license_id=?;`,
		args: [expiresAt, ahoraMs, licenseId],
	});

	return expiresAt;
}

export function revokeLicense(sql: SqlSync, licenseId: string, ahoraMs: number): void {
	sql.execute({
		sql: `UPDATE licenses SET status='revoked', disabled=1, updated_at_ms=? WHERE license_id=?;`,
		args: [ahoraMs, licenseId],
	});
}

/**
 * LIC-07: deshace una revocación. La usan el cierre de una disputa GANADA, sólo sobre lo que revocó
 * esa disputa (el dinero vuelve, así que cortar el servicio deja de tener motivo; AUD-08), y
 * `desrevocar` (`/unrevoke` de la administración).
 *
 * El estado al que regresa depende de si la licencia llegó a activarse: una que nunca se activó
 * vuelve a `issued` (su reloj no había arrancado) y una activada a `active`. Si además caducó
 * mientras tanto, `computeLicenseState` ya lo resuelve por `expires_at_ms`: aquí no se toca.
 *
 * AUD-07: una clave canjeada vuelve a `redeemed`. Tampoco se activó nunca, así que volvía a
 * `issued`: anularla y desanularla la dejaba otra vez sin estrenar, con su tiempo ya sumado a otra.
 */
export function reactivateLicense(sql: SqlSync, licenseId: string, ahoraMs: number): void {
	sql.execute({
		sql: `
    UPDATE licenses
    SET status = CASE
            WHEN redeemed_into_license_id IS NOT NULL THEN 'redeemed'
            WHEN activated_at_ms IS NULL THEN 'issued'
            ELSE 'active'
        END,
        disabled = 0,
        updated_at_ms = ?
    WHERE license_id = ? AND status = 'revoked';
    `,
		args: [ahoraMs, licenseId],
	});
}

/**
 * AUD-08 · La marca del cobro de un alta disputada cuya licencia NO revocó esa disputa: ya estaba
 * revocada al abrirse, o se revocó a mano mientras seguía abierta. Ganar la disputa le quita la
 * marca (el dinero ha vuelto) y no toca la licencia. Perderla la deja como está.
 */
export const DISPUTA_SIN_REVOCAR = "dispute_ya_revocada";

/** ¿Está anulada? Revocada, o desactivada (`disabled`). */
export function estaAnulada(lic: Pick<LicenseRow, "status" | "disabled">): boolean {
	return lic.status === "revoked" || toBool01(lic.disabled);
}
