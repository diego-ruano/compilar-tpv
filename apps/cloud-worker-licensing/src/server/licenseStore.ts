// src/server/licenseStore.ts
//
// Almacén del control-plane de licencias (Turso central). Aquí vive TODO el SQL de
// `licenses`, del OTP de cambio de dispositivo, de los dispositivos y de los eventos de
// webhook. Las reglas (¿está caducada? ¿avisa? ¿bloquea?) NO están aquí: son de
// `licensing.helpers.ts` (`computeLicenseState`).
//
// La estructura de esta base NO se toca desde el código: se gestiona a mano en Turso, y cómo es
// está en `docs/sql/control-plane/esquema-actual.sql`.
//
// Invariantes:
//   · La clave en claro NUNCA se guarda: solo `sha256` (único, indexado) y AES-GCM.
//   · Una licencia = un tenant = un Main (`main_device_id`). Cambiarlo exige OTP.
//   · `customer_email` es obligatorio: es la raíz de confianza de la recuperación.

import type { LicenseOrigin, LicenseStatus } from "../shared";
import { cifrar, descifrar, versionActual, type ClavesOClave } from "./crypto";
import { generateLicenseKey, licenseKeyHash, licenseKeyShort } from "../domains/licensing/licenseKey";
import { exec, type Sql } from "./db";

export type LicenseRow = {
	license_id: string;
	license_key_hash: string;
	license_key_enc: string | null;
	key_short: string | null;

	tenant_id: string | null;
	main_device_id: string | null;
	/** La licencia a la que se sumó el tiempo de esta clave, si se canjeó (`status = 'redeemed'`). */
	redeemed_into_license_id: string | null;

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

export async function getLicenseByHash(db: Sql, licHash: string): Promise<LicenseRow | null> {
	const r = await exec(db, `SELECT * FROM licenses WHERE license_key_hash = ? LIMIT 1;`, [licHash]);
	return (r.rows?.[0] as unknown as LicenseRow) ?? null;
}

export async function getLicenseById(db: Sql, licenseId: string): Promise<LicenseRow | null> {
	const r = await exec(db, `SELECT * FROM licenses WHERE license_id = ? LIMIT 1;`, [licenseId]);
	return (r.rows?.[0] as unknown as LicenseRow) ?? null;
}

/** El rechazo de una clave que no es la registrada, o de un equipo registrado sin ninguna. */
function errorDeClave(code: "device_key_mismatch" | "device_key_missing"): Error {
	return Object.assign(new Error(code), { code });
}

/**
 * Exige que un equipo YA conocido presente la clave pública con la que está registrado, esté su
 * fila en el negocio que esté (REV-07, REV-13). Devuelve el negocio en el que la nube lo tiene
 * registrado, o `null` si ese `device_id` no tiene fila.
 *
 * `exigirClaveSiEsDeOtroNegocio` no sirve para activar: aquél cubre el robo ENTRE negocios y se
 * aparta en cuanto el dispositivo es del tenant que autoriza, que es justo el caso del canje y el de
 * un cambio de equipo hacia una Handy del propio negocio. Y el `device_id` no es un secreto —viaja
 * en los mensajes de presencia del WebSocket (REV-07)—, así que sin esto bastaría con conocer el de
 * otro bar para gastar una clave sobre su licencia.
 *
 * AUD-01: la clave pública tampoco es un secreto, y aquí sólo se comparan dos cadenas. Que quien la
 * presenta tiene su privada lo comprueba antes la ruta, con la firma de la petición
 * (`verificarFirmaDeActivacion`). Por eso mismo **una fila sin clave registrada no pasa**
 * (`device_key_missing`): la firma sólo prueba la clave que se presenta, y darla por buena sería
 * dejar que el primero que firme se quede con ese equipo. El alta escribe la fila con su clave en
 * una sola sentencia (`ensureDevice`), así que una fila así no sale del uso normal.
 */
export async function exigirLaClaveDeEsteEquipo(
	db: Sql,
	deviceId: string,
	pubB64: string,
): Promise<{ tenantId: string } | null> {
	const r = await exec(
		db,
		`SELECT tenant_id, device_pubkey_b64 FROM devices WHERE device_id=? LIMIT 1;`,
		[deviceId],
	);
	const fila = r.rows?.[0] as any | undefined;
	if (!fila) return null;

	const registrada = String(fila.device_pubkey_b64 || "").trim();
	if (!registrada) throw errorDeClave("device_key_missing");
	if (registrada !== pubB64.trim()) throw errorDeClave("device_key_mismatch");
	return { tenantId: String(fila.tenant_id || "").trim() };
}

/**
 * La licencia viva de la que este equipo es la Main, si la hay (REV-13).
 *
 * Es lo que convierte una clave nueva en tiempo añadido en vez de en un negocio nuevo: el mismo
 * enlace de compra sirve para estrenar y para renovar, y lo que decide es lo que el TPV ya tiene
 * cuando se teclea el código, no por dónde se compró.
 *
 * `active` y `expired`, las dos: renovar cuando ya se te ha pasado la fecha es EL caso normal.
 * `revoked` no — a quien se le ha cortado el servicio no se le devuelve pagando otra clave; eso
 * pasa por administración.
 *
 * AUD-01: con `tenantId`, sólo la de ese negocio. Un equipo puede ser la Main de dos licencias
 * vivas de negocios distintos (las dos suyas, o una que otro le apuntó antes de que activar
 * exigiera firma), y sin esto el canje elegía la que más tarde caduca: la renovación se iba a la
 * otra y la Main recibía su negocio. El negocio es el de su fila de `devices`, que es lo que la nube
 * tiene registrado; sin `tenantId` sólo se pregunta por un equipo que no tiene fila.
 */
export async function licenciaVivaDelDispositivo(
	db: Sql,
	deviceId: string,
	tenantId?: string,
): Promise<LicenseRow | null> {
	const r = await exec(
		db,
		`
    SELECT * FROM licenses
    WHERE main_device_id = ?
      AND disabled = 0
      AND status IN ('active', 'expired')
      AND (? IS NULL OR tenant_id = ?)
    ORDER BY expires_at_ms DESC
    LIMIT 1;
    `,
		[deviceId, tenantId ?? null, tenantId ?? null],
	);
	return (r.rows?.[0] as unknown as LicenseRow) ?? null;
}

/**
 * ¿Sigue siendo ésta la licencia viva de la que ese equipo es la Main? Para preguntarlo DENTRO de
 * la transacción del canje (AUD-01): entre que la ruta elige la licencia y gasta la clave, la
 * licencia se puede haber anulado o trasladado a otro equipo, y sumarle tiempo entonces sería
 * gastar la clave sobre una licencia que ya no es de quien la teclea.
 */
export async function sigueSiendoLaLicenciaDelEquipo(
	db: Sql,
	licenseId: string,
	deviceId: string,
): Promise<boolean> {
	const r = await exec(
		db,
		`
    SELECT 1 AS viva FROM licenses
    WHERE license_id = ?
      AND main_device_id = ?
      AND disabled = 0
      AND status IN ('active', 'expired')
    LIMIT 1;
    `,
		[licenseId, deviceId],
	);
	return (r.rows?.length ?? 0) > 0;
}

/**
 * Gasta una clave **sin estrenar** sobre otra licencia, y dice si ha sido esta llamada la que la
 * ha gastado (REV-13).
 *
 * El `WHERE` es la mitad importante: sólo se canjea lo que sigue `issued` y sin equipo. Una
 * licencia **ya activada no suma tiempo** —decisión de producto: si lo que quieres es mover una
 * licencia a otro local, eso es un cambio de equipo y va por su propia pantalla, reciclando la que
 * hay en vez de creando otra—. Y mirar `rowsAffected` es la lección de REV-15: una condición de
 * carrera que nadie comprueba no es una condición de carrera, y aquí dos intentos a la vez
 * sumarían el doble de meses.
 */
export async function canjearLicencia(
	db: Sql,
	claveId: string,
	sobreLicenciaId: string,
): Promise<boolean> {
	const r = await exec(
		db,
		`UPDATE licenses
        SET status = 'redeemed',
            redeemed_into_license_id = ?,
            updated_at_ms = ?
      WHERE license_id = ?
        AND status = 'issued'
        AND main_device_id IS NULL
        AND disabled = 0;`,
		[sobreLicenciaId, Date.now(), claveId],
	);
	return Number((r as any)?.rowsAffected ?? 0) > 0;
}

/**
 * Pasa el cobro de una clave canjeada a la licencia que recibió su tiempo, como renovación.
 *
 * Sin esto, un reembolso de esa compra no quitaría nada: `localizarCobros` (LIC-07) llega al
 * cobro por el `payment_intent`, y ese cobro seguiría apuntando a la clave gastada —que ya no
 * tiene meses que quitar— en vez de a la licencia donde de verdad fueron a parar. Se **mueve** en
 * vez de insertar otro porque `license_payments` tiene índice único por sesión y unidad: otra fila
 * con la misma es justo lo que esa barrera impide.
 */
export async function reasignarCobrosDeLaClave(
	db: Sql,
	claveId: string,
	aLicenciaId: string,
): Promise<void> {
	await exec(
		db,
		`UPDATE license_payments SET license_id = ?, kind = 'renewal' WHERE license_id = ?;`,
		[aLicenciaId, claveId],
	);
}

/**
 * Las licencias a las que les queda poco y hay que avisar (REV-13).
 *
 * Sólo **activadas**: una `issued` que nadie ha estrenado no tiene reloj corriendo, así que no
 * caduca ni hay nada que renovarle. Y sólo vivas (`disabled = 0`, no anuladas): avisar a quien le
 * revocaste la licencia de que va a caducar es ruido, y encima confuso.
 *
 * La ventana es `(desde, hasta]` en milisegundos de caducidad, y la decide quien llama: así el
 * mismo SELECT sirve para el peldaño de 30 días y para el de 7 sin repetir la consulta.
 */
export async function licenciasPorCaducar(
	db: Sql,
	desdeMs: number,
	hastaMs: number,
): Promise<LicenseRow[]> {
	const r = await exec(
		db,
		`
    SELECT * FROM licenses
    WHERE status = 'active'
      AND disabled = 0
      AND expires_at_ms IS NOT NULL
      AND expires_at_ms > ?
      AND expires_at_ms <= ?
    ORDER BY expires_at_ms ASC;
    `,
		[desdeMs, hastaMs],
	);
	return (r.rows ?? []) as unknown as LicenseRow[];
}

/**
 * Marca un aviso como enviado, y dice si ha sido ESTA llamada la que lo ha marcado.
 *
 * Devolver el resultado es lo que hace que el aviso salga una vez: se marca **antes** de enviar y
 * sólo se envía si se ganó la fila. Dos ejecuciones del cron a la vez, o un reintento, encuentran
 * la fila puesta y no mandan nada. (REV-15 enseñó la otra mitad: un `INSERT` condicionado cuyo
 * resultado nadie mira no condiciona nada.)
 *
 * La clave incluye `expires_at_ms` a propósito. Sin él, una licencia renovada nunca volvería a
 * avisar: la fila del año pasado seguiría ahí. Con él, mover la caducidad —renovar, o acortarla
 * desde administración— abre un aviso nuevo y deja el anterior como rastro de lo que se mandó.
 */
export async function marcarAvisoEnviado(
	db: Sql,
	args: { licenseId: string; kind: string; expiresAtMs: number; nowMs: number },
): Promise<boolean> {
	const r = await exec(
		db,
		`INSERT OR IGNORE INTO license_notices (license_id, kind, expires_at_ms, sent_at_ms)
     VALUES (?, ?, ?, ?);`,
		[args.licenseId, args.kind, args.expiresAtMs, args.nowMs],
	);
	return Number((r as any)?.rowsAffected ?? 0) > 0;
}

/** Deshace el marcado: para cuando el envío falla y queremos que el próximo ciclo lo reintente. */
export async function olvidarAvisoEnviado(
	db: Sql,
	args: { licenseId: string; kind: string; expiresAtMs: number },
): Promise<void> {
	await exec(
		db,
		`DELETE FROM license_notices WHERE license_id = ? AND kind = ? AND expires_at_ms = ?;`,
		[args.licenseId, args.kind, args.expiresAtMs],
	);
}

export async function listLicenses(db: Sql, limit = 50, offset = 0): Promise<LicenseRow[]> {
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
	/** Con qué se cifra la clave en reposo (`LICENSE_STORE_KEY`, ver `server/crypto.ts`). */
	claves: ClavesOClave;
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
	db: Sql,
	args: IssueLicenseArgs,
): Promise<{ license: LicenseRow; keyPlain: string }> {
	const keyPlain = generateLicenseKey();
	const licHash = await licenseKeyHash(keyPlain);
	const keyEnc = await cifrar(args.claves, keyPlain);

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
 *
 * Condicionada en SQL a que siga sin activar (`main_device_id IS NULL`), para que dos activaciones
 * simultáneas no puedan pisarse. Devuelve `null` si **no** ganó esa carrera (REV-15).
 *
 * AUD-07: y a que siga sin estrenar (`status = 'issued'`). Un canje deja la clave `redeemed` con
 * `main_device_id` a NULL, y sin esta condición la misma clave estrenaba después un negocio nuevo
 * con su plazo entero. La ruta ya lo rechaza al leerla; esto cierra la carrera del equipo que la
 * leyó `issued` y llega aquí cuando otro ya la ha canjeado (lo que tarda en aprovisionar su base).
 *
 * ⚠️ Mirar el resultado es la mitad que faltaba. El `WHERE` estaba desde el principio, pero nadie
 * comprobaba si había afectado a alguna fila, así que la perdedora seguía como si tal cosa: se
 * llevaba un token y la DEK de un tenant que la licencia no apunta, o sea dos equipos creyéndose
 * la Main del mismo negocio con dos bases distintas. Una condición de carrera que no se comprueba
 * es una condición de carrera.
 */
export async function activateLicenseFirstTime(
	db: Sql,
	args: { licenseId: string; tenantId: string; deviceId: string; termMonths: number },
): Promise<number | null> {
	const now = Date.now();
	const expiresAt = addMonths(now, args.termMonths);

	const r = await exec(
		db,
		`
    UPDATE licenses
    SET status='active',
        tenant_id=?,
        main_device_id=?,
        activated_at_ms=?,
        expires_at_ms=?,
        updated_at_ms=?
    WHERE license_id=? AND main_device_id IS NULL AND status = 'issued';
    `,
		[args.tenantId, args.deviceId, now, expiresAt, now, args.licenseId],
	);

	return Number((r as any)?.rowsAffected ?? 0) > 0 ? expiresAt : null;
}

/** Reasigna el Main (cambio de dispositivo) y deja la traza de auditoría. */
export async function reassignMainDevice(
	db: Sql,
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
	db: Sql,
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
 * Sella la licencia con la sesión de Stripe que acaba de pagarla: es el ÚLTIMO cobro, y cada
 * renovación la sobrescribe. Por eso no sirve de barrera de idempotencia (REV-01): el reintento
 * de una renovación antigua ya no la encontraría aquí. La barrera es `license_payments`.
 */
export async function attachStripeSession(
	db: Sql,
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

export async function revokeLicense(db: Sql, licenseId: string): Promise<void> {
	const now = Date.now();
	await exec(
		db,
		`UPDATE licenses SET status='revoked', disabled=1, updated_at_ms=? WHERE license_id=?;`,
		[now, licenseId],
	);
}

/**
 * LIC-07: deshace una revocación. La usan el cierre de una disputa GANADA, sólo sobre lo que revocó
 * esa disputa (el dinero vuelve, así que cortar el servicio deja de tener motivo; AUD-08), y
 * `/unrevoke` de la administración.
 *
 * El estado al que regresa depende de si la licencia llegó a activarse: una que nunca se activó
 * vuelve a `issued` (su reloj no había arrancado) y una activada a `active`. Si además caducó
 * mientras tanto, `computeLicenseState` ya lo resuelve por `expires_at_ms`: aquí no se toca.
 *
 * AUD-07: una clave canjeada vuelve a `redeemed`. Tampoco se activó nunca, así que volvía a
 * `issued`: anularla y desanularla la dejaba otra vez sin estrenar, con su tiempo ya sumado a otra.
 */
export async function reactivateLicense(db: Sql, licenseId: string): Promise<void> {
	const now = Date.now();
	await exec(
		db,
		`
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
	db: Sql,
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
	/** RI-52: qué unidad de la compra es (1…N). Una compra de 4 licencias son 4 cobros. */
	unidad: number;
	at_ms: number;
};

/**
 * LIC-07: registra un cobro cumplido (alta o renovación) para poder revertirlo después. Hay uno
 * por licencia emitida: una compra de varias unidades deja uno por unidad (RI-52).
 */
export async function recordLicensePayment(
	db: Sql,
	args: {
		licenseId: string;
		kind: LicensePaymentKind;
		termMonths: number;
		sessionId: string | null;
		paymentIntentId: string | null;
		unidad?: number;
	},
): Promise<void> {
	await exec(
		db,
		`
    INSERT INTO license_payments
      (payment_id, license_id, kind, term_months, stripe_checkout_session_id,
       stripe_payment_intent_id, unidad, at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?);
    `,
		[
			crypto.randomUUID(),
			args.licenseId,
			args.kind,
			args.termMonths,
			args.sessionId,
			args.paymentIntentId,
			args.unidad ?? 1,
			Date.now(),
		],
	);
}

/**
 * REV-01: un cobro de esa sesión de checkout, si ya se cumplió. Es la barrera de idempotencia del
 * webhook de pago: se cumple entera en una transacción, así que con que haya uno ya está. Y si dos
 * entregas se cruzan, el índice único `ux_license_payments_session_unidad` rechaza la unidad 1 de
 * la segunda y su transacción entera se deshace.
 */
export async function getLicensePaymentBySession(
	db: Sql,
	sessionId: string,
): Promise<LicensePaymentRow | null> {
	const r = await exec(
		db,
		`SELECT * FROM license_payments WHERE stripe_checkout_session_id = ? LIMIT 1;`,
		[sessionId],
	);
	return (r.rows?.[0] as unknown as LicensePaymentRow) ?? null;
}

/**
 * LIC-07: los cobros a los que apunta un cargo de Stripe (por su PaymentIntent). Uno por licencia
 * de la compra (RI-52): un reembolso total o una disputa los revierte todos.
 */
export async function getLicensePaymentsByIntent(
	db: Sql,
	paymentIntentId: string,
): Promise<LicensePaymentRow[]> {
	const r = await exec(
		db,
		`
    SELECT * FROM license_payments
    WHERE stripe_payment_intent_id = ?
    ORDER BY unidad ASC, at_ms ASC;
    `,
		[paymentIntentId],
	);
	return (r.rows ?? []) as unknown as LicensePaymentRow[];
}

/** LIC-07: marca un cobro como devuelto. Impide que dos eventos de Stripe lo reviertan dos veces. */
export async function markLicensePaymentReversed(
	db: Sql,
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
	db: Sql,
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
 * AUD-08 · La marca del cobro de un alta disputada cuya licencia NO revocó esa disputa: ya estaba
 * revocada al abrirse, o se revocó a mano mientras seguía abierta. Ganar la disputa le quita la
 * marca (el dinero ha vuelto) y no toca la licencia. Perderla la deja como está.
 */
export const DISPUTA_SIN_REVOCAR = "dispute_ya_revocada";

/**
 * AUD-08 · Revocar a mano una licencia cuya alta había revocado una disputa que sigue abierta hace
 * suya la revocación: el cobro deja de figurar como revocado por la disputa, y ganarla ya no
 * resucita la licencia. Va en la misma transacción que `revokeLicense`.
 *
 * Sólo las altas: una renovación disputada no revoca nada (resta meses), y devolvérselos al
 * ganarla no reactiva una licencia revocada (`extendLicense` no toca `status = 'revoked'`).
 */
export async function atribuirRevocacionAMano(db: Sql, licenseId: string): Promise<void> {
	await exec(
		db,
		`
    UPDATE license_payments SET reversed_reason = ?
    WHERE license_id = ? AND kind = 'issue' AND reversed_reason = 'dispute';
    `,
		[DISPUTA_SIN_REVOCAR, licenseId],
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
	db: Sql,
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
	db: Sql,
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
export async function markKeyEmailSent(db: Sql, licenseId: string): Promise<void> {
	const now = Date.now();
	await exec(
		db,
		`UPDATE licenses SET key_email_sent_at_ms=?, updated_at_ms=? WHERE license_id=?;`,
		[now, now, licenseId],
	);
}

/**
 * RI-73 · Guarda la clave de una licencia ya recifrada con la `LICENSE_STORE_KEY` actual, sólo si la
 * columna sigue teniendo lo que se leyó.
 */
export async function guardarClaveRecifrada(
	db: Sql,
	licenseId: string,
	leida: string,
	recifrada: string,
): Promise<void> {
	await exec(
		db,
		`UPDATE licenses SET license_key_enc=?, updated_at_ms=? WHERE license_id=? AND license_key_enc=?;`,
		[recifrada, Date.now(), licenseId, leida],
	);
}

/** RI-73 · Todo lo que la base central guarda cifrado con `LICENSE_STORE_KEY`. */
const COLUMNAS_CIFRADAS = [
	{ nombre: "licencias", tabla: "licenses", id: "license_id", columna: "license_key_enc" },
	{ nombre: "deks", tabla: "tenants", id: "tenant_id", columna: "field_dek" },
	{ nombre: "tokensTurso", tabla: "tenant_databases", id: "tenant_id", columna: "turso_auth_token_enc" },
] as const;

export type ResultadoRecifrado = {
	/** Cuántos valores de cada columna se han pasado a la clave actual en esta llamada. */
	recifrados: Record<(typeof COLUMNAS_CIFRADAS)[number]["nombre"], number>;
	/** Los que no se dejan descifrar con ninguna clave configurada: hay que mirarlos a mano. */
	ilegibles: { tabla: string; id: string }[];
	/** `true` si se ha llegado al techo y quedan más: hay que volver a llamar. */
	quedanMas: boolean;
};

/**
 * RI-73 · Pasa a la clave actual lo que siga cifrado con otra: es el final de una rotación de
 * `LICENSE_STORE_KEY`, para no esperar a que cada valor se lea. Como mucho `techo` valores por
 * llamada (el techo va en la respuesta entera, no en cada tabla). Cada escritura va condicionada a
 * que la columna siga teniendo lo leído, así que puede correr a la vez que el tráfico normal.
 */
export async function recifrarConLaActual(
	db: Sql,
	claves: ClavesOClave,
	techo: number,
): Promise<ResultadoRecifrado> {
	const res: ResultadoRecifrado = {
		recifrados: { licencias: 0, deks: 0, tokensTurso: 0 },
		ilegibles: [],
		quedanMas: false,
	};
	const conLaActual = `k${versionActual(claves)}:%`;
	let quedan = techo;

	for (const c of COLUMNAS_CIFRADAS) {
		// Se pide uno más de lo que cabe: si llega, es que quedan más (con el cupo ya agotado, la
		// consulta sólo sirve para saberlo).
		const r = await exec(
			db,
			`SELECT ${c.id} AS id, ${c.columna} AS valor FROM ${c.tabla}
			  WHERE ${c.columna} IS NOT NULL AND ${c.columna} <> '' AND ${c.columna} NOT LIKE ?
			  LIMIT ?;`,
			[conLaActual, quedan + 1],
		);
		const filas = (r.rows ?? []) as any[];
		if (filas.length > quedan) res.quedanMas = true;

		for (const f of filas.slice(0, quedan)) {
			quedan--;
			const leido = String(f.valor);
			let nuevo: string;
			try {
				const { texto, recifrado } = await descifrar(claves, leido);
				nuevo = recifrado ?? (await cifrar(claves, texto));
			} catch {
				res.ilegibles.push({ tabla: c.tabla, id: String(f.id) });
				continue;
			}
			await exec(db, `UPDATE ${c.tabla} SET ${c.columna}=? WHERE ${c.id}=? AND ${c.columna}=?;`, [
				nuevo,
				String(f.id),
				leido,
			]);
			res.recifrados[c.nombre]++;
		}
	}
	return res;
}

/** Persiste los datos del negocio que llegan en la activación (corrige el bug #5). */
export async function upsertTenantInfo(
	db: Sql,
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

export async function ensureTenantExistsMinimal(db: Sql, tenantId: string) {
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
	db: Sql,
	claves: ClavesOClave,
	tenantId: string,
): Promise<string> {
	const existente = await leerFieldDek(db, claves, tenantId);
	if (existente) return existente;

	const bytes = crypto.getRandomValues(new Uint8Array(32));
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	const dekB64 = btoa(bin);

	const cifrada = await cifrar(claves, dekB64);

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

	const ganadora = await leerFieldDek(db, claves, tenantId);
	if (!ganadora) throw new Error("field_dek_no_persistida");
	return ganadora;
}

async function leerFieldDek(
	db: Sql,
	claves: ClavesOClave,
	tenantId: string,
): Promise<string | null> {
	const r = await db.execute({
		sql: `SELECT field_dek FROM tenants WHERE tenant_id=? LIMIT 1;`,
		args: [tenantId],
	});

	const guardada = String((r.rows?.[0] as any)?.field_dek ?? "").trim();
	if (!guardada) return null;

	const { texto, recifrado } = await descifrar(claves, guardada);
	// RI-73: estaba cifrada con la clave anterior. Se guarda ya con la actual, condicionado a que siga
	// siendo la que se leyó (si otra petición la ha cambiado, se deja la suya).
	if (recifrado) {
		await db.execute({
			sql: `UPDATE tenants SET field_dek=?, updated_at_ms=? WHERE tenant_id=? AND field_dek=?;`,
			args: [recifrado, Date.now(), tenantId, guardada],
		});
	}
	return texto;
}

/* ============================================================
   OTP de cambio de dispositivo
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
	db: Sql,
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

/**
 * RI-68 · Reserva uno de los códigos del día de esta licencia: `true` si quedaba alguno.
 *
 * Contar y anotar van en UNA sentencia, para que dos peticiones a la vez no puedan pasar las dos con
 * el último hueco.
 */
export async function reservarEnvioDeOtp(
	db: Sql,
	args: { licenseId: string; ahoraMs: number; ventanaMs: number; maximo: number },
): Promise<boolean> {
	const r = await exec(
		db,
		`
    INSERT INTO license_otp_eventos (license_id, tipo, at_ms)
    SELECT ?1, 'envio', ?2
    WHERE (SELECT COUNT(*) FROM license_otp_eventos
            WHERE license_id = ?1 AND tipo = 'envio' AND at_ms > ?3) < ?4;
    `,
		[args.licenseId, args.ahoraMs, args.ahoraMs - args.ventanaMs, args.maximo],
	);
	return Number((r as any)?.rowsAffected ?? 0) > 0;
}

/**
 * RI-68 / AUD-04 · Reserva uno de los códigos incorrectos del día de esta licencia (no de la pareja)
 * ANTES de comparar: `true` si quedaba alguno.
 *
 * Contar y anotar van en UNA sentencia, como en `reservarEnvioDeOtp`: contando primero y anotando
 * después de comparar, las peticiones que llegan a la vez cuentan todas lo mismo y se comparan todas.
 * La fila reservada ES el fallo; si el código resulta ser el bueno se devuelve con
 * `devolverFalloDeOtp`.
 */
export async function reservarFalloDeOtp(
	db: Sql,
	args: { licenseId: string; ahoraMs: number; ventanaMs: number; maximo: number },
): Promise<boolean> {
	const r = await exec(
		db,
		`
    INSERT INTO license_otp_eventos (license_id, tipo, at_ms)
    SELECT ?1, 'fallo', ?2
    WHERE (SELECT COUNT(*) FROM license_otp_eventos
            WHERE license_id = ?1 AND tipo = 'fallo' AND at_ms > ?3) < ?4;
    `,
		[args.licenseId, args.ahoraMs, args.ahoraMs - args.ventanaMs, args.maximo],
	);
	return Number((r as any)?.rowsAffected ?? 0) > 0;
}

/**
 * AUD-04 · Devuelve la reserva de `reservarFalloDeOtp`: el código era el bueno y no cuenta como fallo
 * del día. La tabla no tiene clave, así que se quita UNA fila con la hora de la reserva; si otra
 * petición reservó en el mismo milisegundo las dos filas son iguales y da lo mismo cuál se vaya.
 */
export async function devolverFalloDeOtp(db: Sql, licenseId: string, ahoraMs: number): Promise<void> {
	await exec(
		db,
		`
    DELETE FROM license_otp_eventos
    WHERE rowid = (SELECT rowid FROM license_otp_eventos
                    WHERE license_id = ?1 AND tipo = 'fallo' AND at_ms = ?2 LIMIT 1);
    `,
		[licenseId, ahoraMs],
	);
}

export async function getDeviceOtp(
	db: Sql,
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

/**
 * AUD-04 · Reserva uno de los intentos del código ANTES de compararlo, en una sola sentencia:
 * devuelve la huella con la que comparar, o `null` si no hay nada que comparar (no hay código, está
 * consumido o caducado, o ya no le quedan intentos). Mirar el contador y sumarlo después de comparar
 * dejaba pasar a la vez a todas las peticiones que lo leían antes de que ninguna escribiera.
 *
 * Un código caducado no gasta intento: no se va a comparar.
 */
export async function reservarIntentoDeOtp(
	db: Sql,
	args: { licenseId: string; newDeviceId: string; ahoraMs: number; maximo: number },
): Promise<{ codeHash: string } | null> {
	const r = await exec(
		db,
		`
    UPDATE license_device_otp
    SET attempts = attempts + 1
    WHERE license_id=? AND new_device_id=? AND consumed_at_ms IS NULL AND attempts < ?
      AND expires_at_ms >= ?
    RETURNING code_hash;
    `,
		[args.licenseId, args.newDeviceId, args.maximo, args.ahoraMs],
	);
	const row = r.rows?.[0] as any;
	return row ? { codeHash: String(row.code_hash) } : null;
}

/**
 * AUD-04 · Devuelve la reserva de `reservarIntentoDeOtp` cuando al final no se compara nada (el tope
 * del día no concedió la suya): un rechazo sin comparación no gasta intentos del código, que tiene
 * que seguir valiendo cuando el día se libere. Sólo sobre el código de esa huella: si entre medias
 * se pidió otro, el nuevo no se toca.
 */
export async function devolverIntentoDeOtp(
	db: Sql,
	args: { licenseId: string; newDeviceId: string; codeHash: string },
): Promise<void> {
	await exec(
		db,
		`
    UPDATE license_device_otp
    SET attempts = attempts - 1
    WHERE license_id=? AND new_device_id=? AND code_hash=? AND consumed_at_ms IS NULL AND attempts > 0;
    `,
		[args.licenseId, args.newDeviceId, args.codeHash],
	);
}

/**
 * Consume el OTP de forma **atómica**: solo consume si sigue sin consumir. Devuelve `false`
 * si otro intento se le adelantó (anti-replay ante peticiones concurrentes).
 *
 * AUD-04: consume sólo el código de esa huella (`codeHash`, la que devolvió `reservarIntentoDeOtp` y
 * con la que se comparó) y sólo si no ha caducado a la hora de consumir. Si entre la comparación y
 * esto se pidió otro código, el nuevo sigue vivo. No comprueba que quien llama tenga una reserva ni
 * mira `attempts`: de eso responde la ruta, que sólo llega aquí después de reservar y comparar.
 */
export async function consumeDeviceOtp(
	db: Sql,
	licenseId: string,
	newDeviceId: string,
	codeHash: string,
): Promise<boolean> {
	const ahora = Date.now();
	const r = await exec(
		db,
		`
    UPDATE license_device_otp
    SET consumed_at_ms = ?
    WHERE license_id=? AND new_device_id=? AND consumed_at_ms IS NULL AND code_hash=?
      AND expires_at_ms >= ?
    RETURNING license_id;
    `,
		[ahora, licenseId, newDeviceId, codeHash, ahora],
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

export async function getEmailCode(db: Sql, k: EmailCodeKey): Promise<EmailCodeRow | null> {
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
	db: Sql,
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
	db: Sql,
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
export async function consumeEmailCode(db: Sql, k: EmailCodeKey, nowMs: number): Promise<boolean> {
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
export async function voidEmailCode(db: Sql, k: EmailCodeKey, nowMs: number): Promise<void> {
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
export async function getTenantRecoveryEmail(db: Sql, tenantId: string): Promise<string | null> {
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
	db: Sql,
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
	db: Sql,
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

/**
 * La pubkey de un `device_id` esté registrado en el negocio que esté. Sólo para readmitir a una
 * Main cuya fila pasó a otro negocio (`readmitirMain` en `licensing.helpers.ts`): la identidad del
 * equipo es la misma en todos, así que su clave también.
 */
export async function getDevicePubKeyB64EnCualquierNegocio(
	db: Sql,
	deviceId: string,
): Promise<string | null> {
	const r = await exec(db, `SELECT device_pubkey_b64 FROM devices WHERE device_id=? LIMIT 1;`, [deviceId]);
	const row = (r.rows?.[0] as any) || null;
	const v = row ? String(row.device_pubkey_b64 || "").trim() : "";
	return v ? v : null;
}

/**
 * REV-07: un `device_id` de OTRO negocio no se toca sin su clave.
 *
 * Un equipo tiene una sola identidad para sus dos modos, así que su fila puede mudarse de negocio
 * (docs/arquitectura/emparejamiento.md, `readmitirMain`) — pero mudarse es algo que hace **él**, firmando con su clave.
 * Lo que no puede es que otro se lo lleve: bastaba presentar un `device_id` ajeno para que el
 * `ON CONFLICT(device_id) DO UPDATE` del alta moviera la fila de la víctima, y en el camino del
 * emparejamiento también su `device_pubkey_b64`.
 *
 * ⚠️ **El corte es entre negocios, y el matiz importa.** Dentro del mismo, que la clave cambie es
 * la vía de recuperación que existe hoy: un Handy revocado que se vuelve a vincular queda activo
 * con la clave nueva, y eso lo aprueba el dueño desde su propia Main. Prohibirlo dejaría sin salida
 * a un equipo cuyo par de claves se perdiera —la identidad y la clave viven en dos entradas
 * distintas del almacén de secretos— y no hay ninguna pantalla para limpiar una `device_pubkey_b64`.
 * Queda fuera, por tanto, que alguien de dentro del local le quite el sitio a su propia Main; es el
 * modelo de amenaza que §14 ya asume («cubre a un camarero con el TPV delante, no a un atacante»).
 *
 * Lanza `device_key_mismatch`, y se llama **antes** de tocar nada.
 *
 * AUD-01: aquí sólo se comparan claves públicas, que no son un secreto. La firma la comprueba antes
 * cada puerta que llama a esto, con la clave que le presentan: `/v1/license/activate` sobre la
 * petición entera (`verificarFirmaDeActivacion`) y `fetch-token` sobre su reto de un solo uso. Y
 * por eso una fila de otro negocio **sin clave registrada** tampoco se mueve
 * (`device_key_missing`): la firma sólo prueba la clave presentada, y sin una registrada con la que
 * compararla se la llevaría el primero que firmase.
 */
export async function exigirClaveSiEsDeOtroNegocio(
	db: Sql,
	deviceId: string,
	pubB64: string,
	tenantIdQueAutoriza: string,
): Promise<void> {
	const r = await exec(
		db,
		`SELECT tenant_id, device_pubkey_b64 FROM devices WHERE device_id=? LIMIT 1;`,
		[deviceId],
	);
	const row = (r.rows?.[0] as any) || null;
	if (!row) return;

	const duenyo = String(row.tenant_id || "").trim();
	const registrada = String(row.device_pubkey_b64 || "").trim();

	if (duenyo && duenyo === tenantIdQueAutoriza) return;
	if (!registrada) throw errorDeClave("device_key_missing");
	if (registrada === pubB64.trim()) return;

	throw errorDeClave("device_key_mismatch");
}

/**
 * Alta o readmisión del dispositivo, **con su clave y en una sola sentencia**. La llaman
 * `/v1/license/activate` —alguien ha presentado una clave de licencia válida (y el OTP al email del
 * titular si era un cambio de equipo), firmando con la clave del equipo— y `readmitirMain`.
 *
 * AUD-01: la fila nace con su clave, y una que ya existe sólo se toca si su clave registrada es
 * ésta (el `WHERE` del `DO UPDATE`). Antes eran dos escrituras —la fila, y después la clave si
 * faltaba—: un corte entre las dos dejaba una fila sin clave, que cualquiera podía reclamar
 * firmando con la suya, y la comparación llegaba cuando la fila ya estaba mudada, con rol `tpv` y
 * sin revocar. Si la fila existe con otra clave, o sin ninguna, no se escribe nada y se lanza
 * `device_key_mismatch`.
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
	db: Sql,
	tenantId: string,
	deviceId: string,
	role: "tpv" | "handy",
	devicePubKeyB64: string,
): Promise<void> {
	const now = Date.now();

	const r = await exec(
		db,
		`
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
    `,
		[deviceId, tenantId, role, now, now, devicePubKeyB64.trim()],
	);

	if (Number((r as any)?.rowsAffected ?? 0) <= 0) throw errorDeClave("device_key_mismatch");
}

/* ============================================================
   Eventos de webhook (idempotencia) — ahora de Stripe
============================================================ */

export async function upsertWebhookEvent(
	db: Sql,
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
	// REV-01: sólo está hecho lo que salió bien. Un evento que falló (`processed_ok = 0`) contestó
	// 500 precisamente para que Stripe lo reintentara, y el reintento tiene que procesarse. Lo que
	// impide aplicar dos veces un cobro no es esta tabla, sino la barrera por sesión dentro de la
	// transacción del cumplimiento (`license_payments`).
	const fila = existing.rows?.[0] as unknown as { processed_ok: number } | undefined;
	if (fila) return { already: Number(fila.processed_ok) === 1 };

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
	db: Sql,
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
	db: Sql,
	action:
		| "issue"
		| "revoke"
		| "extend"
		| "resend"
		| "refund"
		| "dispute"
		| "reactivate"
		| "shorten"
		| "interruptor_apagar"
		| "interruptor_encender"
		| "recifrar"
		| "piloto_poner"
		| "piloto_quitar"
		| "release_promocionar"
		| "reserva_web_dominio_poner"
		| "reserva_web_dominio_quitar"
		| "reserva_web_revocar_clave"
		| "pruebas_retirar",
	licenseId: string | null,
	detail: Record<string, unknown>,
) {
	await exec(
		db,
		`INSERT INTO admin_audit (audit_id, action, license_id, detail, at_ms) VALUES (?, ?, ?, ?, ?);`,
		[crypto.randomUUID(), action, licenseId, JSON.stringify(detail), Date.now()],
	);
}
