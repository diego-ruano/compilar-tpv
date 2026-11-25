// src/server/licenseStore.ts
//
// Lo que el Worker lee y escribe en la base central (control-plane) sentencia a sentencia: las
// licencias, el OTP de cambio de dispositivo, los dispositivos y los eventos de webhook. Dos
// sentencias fijas que tienen que entrar juntas van en un lote (el traslado de la Main y su traza,
// `reassignMainDevice`). Lo que tiene que entrar entero y decide por el camino (el canje, el cobro y
// su reversión, lo que la administración hace con una licencia) son operaciones de la central y vive
// en `server/central/operaciones/`, que corre dentro de su objeto; las sentencias que comparten las
// dos partes salen de allí. Las reglas (¿está caducada? ¿avisa? ¿bloquea?) NO están aquí: son de
// `licensing.helpers.ts` (`computeLicenseState`).
//
// La estructura de esta base sólo la cambian sus migraciones (`server/central/migraciones/`).
//
// Invariantes:
//   · La clave en claro NUNCA se guarda: solo `sha256` (único, indexado) y AES-GCM.
//   · Una licencia = un tenant = un Main (`main_device_id`). Cambiarlo exige OTP.
//   · `customer_email` es obligatorio: es la raíz de confianza de la recuperación.

import type { LicenseOrigin, LicenseStatus } from "../shared";
import { cifrar, descifrar, versionActual, type ClavesOClave } from "./crypto";
import { generateLicenseKey, licenseKeyHash, licenseKeyShort } from "../domains/licensing/licenseKey";
import { exec } from "./db";
import type { Base, Sql } from "../lib/sql";
import { CentralNoDisponible } from "./central/cliente";
import { COBROS_DE_LA_SESION } from "./central/operaciones/cobros";
import {
	addMonths,
	argumentosDeLaAuditoria,
	argumentosDeLaLicenciaNueva,
	INSERTAR_AUDITORIA,
	INSERTAR_LICENCIA,
	LICENCIA_POR_ID,
	type LicenciaNueva,
} from "./central/operaciones/licencias";
import { laCentralNoAtiende } from "./central/sinLaCentral";

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
   Lecturas
============================================================ */

export async function getLicenseByHash(db: Sql, licHash: string): Promise<LicenseRow | null> {
	const r = await exec(db, `SELECT * FROM licenses WHERE license_key_hash = ? LIMIT 1;`, [licHash]);
	return (r.rows?.[0] as unknown as LicenseRow) ?? null;
}

export async function getLicenseById(db: Sql, licenseId: string): Promise<LicenseRow | null> {
	const r = await exec(db, LICENCIA_POR_ID, [licenseId]);
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
 * un cambio de equipo hacia una Handy del propio negocio. Y el `device_id` no es un secreto —el de
 * la Main viaja en los avisos del WebSocket (`main_online`, REV-07)—, así que sin esto bastaría con
 * conocer el de otro bar para gastar una clave sobre su licencia.
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

/**
 * Las licencias, de la más nueva a la más vieja. Las de una misma compra nacen en el mismo instante
 * (`emitirCobro`): entre ellas desempata el orden en que se insertaron, y la última unidad va primero.
 */
export async function listLicenses(db: Sql, limit = 50, offset = 0): Promise<LicenseRow[]> {
	const r = await exec(
		db,
		`SELECT * FROM licenses ORDER BY created_at_ms DESC, rowid DESC LIMIT ? OFFSET ?;`,
		[limit, offset],
	);
	return (r.rows ?? []) as unknown as LicenseRow[];
}

/* ============================================================
   Emisión y ciclo de vida
============================================================ */

/**
 * Una clave de licencia nueva: en claro, su huella (`license_key_hash`), su forma corta y cifrada
 * con `LICENSE_STORE_KEY` (`server/crypto.ts`). La clave en claro es para quien la entrega (la
 * respuesta de la administración, el correo del comprador): no se guarda, no viaja a la base
 * central y no se loguea.
 */
export async function claveNueva(
	claves: ClavesOClave,
): Promise<{ keyPlain: string } & Pick<LicenciaNueva, "licHash" | "keyEnc" | "keyShort">> {
	const keyPlain = generateLicenseKey();
	return {
		keyPlain,
		licHash: await licenseKeyHash(keyPlain),
		keyEnc: await cifrar(claves, keyPlain),
		keyShort: licenseKeyShort(keyPlain),
	};
}

export type IssueLicenseArgs = Omit<LicenciaNueva, "licenseId" | "licHash" | "keyEnc" | "keyShort" | "ahoraMs"> & {
	/** Con qué se cifra la clave en reposo (`LICENSE_STORE_KEY`, ver `server/crypto.ts`). */
	claves: ClavesOClave;
};

/**
 * Minta una licencia nueva (sin estrenar: `INSERTAR_LICENCIA`). Devuelve la fila **y la clave en
 * claro**: es la única vez que existe fuera del email del cliente — quien llame decide si la envía o
 * la muestra, y no debe loguearla.
 *
 * Es el alta a mano. Las de una compra de Stripe las da de alta la central con el cobro, juntos
 * (`emitirCobro`, `server/central/operaciones/cobros.ts`).
 */
export async function issueLicense(
	db: Sql,
	{ claves, ...licencia }: IssueLicenseArgs,
): Promise<{ license: LicenseRow; keyPlain: string }> {
	const { keyPlain, ...clave } = await claveNueva(claves);
	const licenseId = crypto.randomUUID();

	await exec(
		db,
		INSERTAR_LICENCIA,
		argumentosDeLaLicenciaNueva({ ...licencia, ...clave, licenseId, ahoraMs: Date.now() }),
	);

	const license = (await getLicenseById(db, licenseId))!;
	return { license, keyPlain };
}

/**
 * AUD-09 · El negocio en el que va a nacer una clave sin estrenar, reservado en la propia licencia.
 *
 * La primera activación crea el negocio y su base ANTES de apuntar la licencia (la base va antes,
 * DO-PERDIDA), así que el identificador del negocio no puede salir de cada petición: lo estrenaba
 * cada una, y una ráfaga de activaciones de la misma clave, o cada reintento tras un fallo, dejaba
 * un negocio, una fila de equipo y un TenantHub aprovisionado que nada borraba. Aquí se elige UNA
 * vez, en una sola sentencia: la primera petición deja el suyo (`tenantNuevo`) y las demás reciben
 * ése (`COALESCE`), así que todas acaban en el mismo negocio y en el mismo objeto, cuyo alta es
 * idempotente.
 *
 * Sólo mientras la clave siga sin estrenar (`issued`, sin Main y sin anular). Devuelve `null` si ya
 * no lo está: otro equipo la ha activado o canjeado, o se ha anulado.
 *
 * Reservar no es nacer: el negocio nace cuando su licencia se activa (`activated_at_ms`,
 * `lib/basePerdida.ts`), y hasta entonces su base todavía se puede crear.
 */
export async function reservarNegocioDeLaClave(
	db: Sql,
	licenseId: string,
	tenantNuevo: string,
	ahoraMs: number,
): Promise<string | null> {
	const r = await exec(
		db,
		`UPDATE licenses
        SET tenant_id = COALESCE(tenant_id, ?),
            updated_at_ms = ?
      WHERE license_id = ?
        AND status = 'issued'
        AND main_device_id IS NULL
        AND disabled = 0
      RETURNING tenant_id;`,
		[tenantNuevo, ahoraMs, licenseId],
	);
	const reservado = String((r.rows?.[0] as any)?.tenant_id ?? "").trim();
	return reservado || null;
}

/**
 * AUD-09 · El negocio de una licencia que ya se activó, o `""` si no tiene ninguno o sólo lo tiene
 * reservado (`reservarNegocioDeLaClave`). Es a quién avisar cuando la licencia cambia: el TenantHub
 * de un negocio que no ha nacido no tiene Main ni socket que cerrar.
 */
export function negocioActivadoDe(lic: Pick<LicenseRow, "tenant_id" | "activated_at_ms">): string {
	return lic.activated_at_ms ? String(lic.tenant_id || "") : "";
}

/**
 * 1ª activación: arranca el reloj y liga la licencia a su tenant y a su Main.
 *
 * Condicionada en SQL a que siga sin activar (`main_device_id IS NULL`), para que dos activaciones
 * simultáneas no puedan pisarse. Devuelve `null` si **no** ganó esa carrera (REV-15).
 *
 * AUD-09: y a que el negocio sea el reservado, si lo hay. Todas las peticiones de la misma clave
 * reciben el mismo (`reservarNegocioDeLaClave`); esto sólo impide que una pise otra reserva.
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
    WHERE license_id=? AND main_device_id IS NULL AND status = 'issued'
      AND (tenant_id IS NULL OR tenant_id = ?);
    `,
		[args.tenantId, args.deviceId, now, expiresAt, now, args.licenseId, args.tenantId],
	);

	return Number((r as any)?.rowsAffected ?? 0) > 0 ? expiresAt : null;
}

/**
 * Reasigna el Main (cambio de dispositivo) y deja la traza de auditoría, en un solo lote: entran las
 * dos o ninguna (E7a-1). Vuelve cuando el traslado ha entrado, y la ruta sigue con los avisos (al
 * `TenantHub` y al titular). Lanza si no ha entrado o no se sabe, y la ruta no avisa de nada.
 *
 * Un viaje que no vuelve con su respuesta (`CentralNoDisponible`) puede haber entrado: la plataforma
 * da el mismo fallo cuando la respuesta se pierde por el camino. Lo dice la traza, cuyo `swap_id`
 * sólo lo tiene este traslado: si está, vuelve como si la respuesta hubiera llegado, con el fallo del
 * viaje para que la ruta lo deje registrado (`registrarSinLaCentral`); si la respuesta llegó, con
 * `null`. Si no está
 * cuando se mira, o la central tampoco contesta a esa lectura, lanza el fallo del viaje; si aun así
 * había entrado, la licencia queda en el equipo nuevo con su traza y sin los avisos, y el reintento
 * de ese equipo ya no es un traslado (`cambioDeEquipo: false`): TRASLADO-REINTENTO, en
 * docs/pendientes.md.
 */
export async function reassignMainDevice(
	db: Base,
	args: { licenseId: string; fromDeviceId: string | null; toDeviceId: string },
): Promise<CentralNoDisponible | null> {
	const now = Date.now();
	const swapId = crypto.randomUUID();

	try {
		await db.batch([
			{
				sql: `UPDATE licenses SET main_device_id=?, updated_at_ms=? WHERE license_id=?;`,
				args: [args.toDeviceId, now, args.licenseId],
			},
			{
				sql: `
    INSERT INTO license_device_swaps (swap_id, license_id, from_device_id, to_device_id, at_ms)
    VALUES (?, ?, ?, ?, ?);
    `,
				args: [swapId, args.licenseId, args.fromDeviceId, args.toDeviceId, now],
			},
		]);
		return null;
	} catch (error) {
		if (!(error instanceof CentralNoDisponible) || !(await hayTrazaDelTraslado(db, swapId, error))) throw error;
		return error;
	}
}

/**
 * ¿Está la traza `swapId`, o sea, ha entrado su traslado? Si la central tampoco contesta a esto, no se
 * sabe: lanza `falloDelViaje`, el del lote. Cualquier otro fallo de la lectura sale tal cual.
 */
async function hayTrazaDelTraslado(db: Sql, swapId: string, falloDelViaje: unknown): Promise<boolean> {
	try {
		const r = await exec(db, `SELECT 1 AS si FROM license_device_swaps WHERE swap_id = ?;`, [swapId]);
		return r.rows.length > 0;
	} catch (e) {
		throw laCentralNoAtiende(e) ? falloDelViaje : e;
	}
}

type LicensePaymentKind = "issue" | "renewal";

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
		recifrados: { licencias: 0, deks: 0 },
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

/**
 * Guarda el código (sólo su HMAC) si toca enviar otro, y lo decide en la MISMA sentencia (AUD-42):
 * que el anterior esté usado o anulado o tenga ya `esperaMs`, y que la ventana de `ventanaMs` haya
 * pasado o lleve menos de `maxEnvios`. El contador y la ventana se calculan en SQL sobre la fila que
 * hay. Leer, decidir y escribir después dejaba pasar a todas las peticiones que leyeran antes de la
 * primera escritura: diez a la vez mandaban diez códigos. Pedir otro sustituye al anterior y
 * reinicia los intentos. Devuelve `false` si no toca (y no escribe nada): quien llama no envía.
 *
 * CORREO-CONFIRMAR · `created_at_ms` es desde cuándo cuenta la espera. Al reservar, sólo frena lo que
 * puede tardar el envío (`enVueloMs`): lo justo para que las peticiones a la vez no manden cada una
 * el suyo, sin que una reserva cuyo correo no llega a salir (o cuya respuesta se pierde) haga esperar
 * la espera entera. Cuando el correo sale, `markEmailCodeSent` la pone en la hora del envío.
 */
export async function reserveEmailCodeSend(
	db: Sql,
	args: EmailCodeKey & {
		subject: string;
		codeHash: string;
		expiresAtMs: number;
		nowMs: number;
		esperaMs: number;
		enVueloMs: number;
		ventanaMs: number;
		maxEnvios: number;
	},
): Promise<boolean> {
	const r = await exec(
		db,
		`
    INSERT INTO email_codes (
      tenant_id, device_id, purpose, subject, code_hash, attempts, expires_at_ms, consumed_at_ms,
      created_at_ms, sends_in_window, window_started_ms
    ) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, NULL, ?7 - ?8 + ?11, 1, ?7)
    ON CONFLICT(tenant_id, device_id, purpose) DO UPDATE SET
      subject = excluded.subject,
      code_hash = excluded.code_hash,
      attempts = 0,
      expires_at_ms = excluded.expires_at_ms,
      consumed_at_ms = NULL,
      created_at_ms = excluded.created_at_ms,
      sends_in_window = CASE WHEN ?7 - email_codes.window_started_ms < ?9
                             THEN email_codes.sends_in_window + 1 ELSE 1 END,
      window_started_ms = CASE WHEN ?7 - email_codes.window_started_ms < ?9
                               THEN email_codes.window_started_ms ELSE ?7 END
    WHERE (email_codes.consumed_at_ms IS NOT NULL OR ?7 - email_codes.created_at_ms >= ?8)
      AND (?7 - email_codes.window_started_ms >= ?9 OR email_codes.sends_in_window < ?10)
    RETURNING sends_in_window;
    `,
		[
			args.tenantId,
			args.deviceId,
			args.purpose,
			args.subject,
			args.codeHash,
			args.expiresAtMs,
			args.nowMs,
			args.esperaMs,
			args.ventanaMs,
			args.maxEnvios,
			args.enVueloMs,
		],
	);
	return (r.rows?.length ?? 0) > 0;
}

/**
 * CORREO-CONFIRMAR · El correo del código ha salido: la espera hasta el siguiente cuenta desde ahora.
 * Sólo si sigue siendo ese código (`codeHash`) y sin usar.
 */
export async function markEmailCodeSent(db: Sql, k: EmailCodeKey, codeHash: string, nowMs: number): Promise<void> {
	await exec(
		db,
		`UPDATE email_codes SET created_at_ms = ?
		 WHERE tenant_id=? AND device_id=? AND purpose=? AND code_hash=? AND consumed_at_ms IS NULL;`,
		[nowMs, k.tenantId, k.deviceId, k.purpose, codeHash],
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

/**
 * CORREO-CONFIRMAR · Gasta el código del cambio de correo (`codeHash`, el que se ha comprobado) y
 * deja el correo de recuperación en `email` (`null`: el de la compra) en un solo lote: entran los
 * dos o ninguno. El cambio sólo se escribe si el código se acaba de gastar en este lote, así que de
 * dos confirmaciones a la vez sólo una gana (la otra escribiría lo mismo: el correo va en el código).
 * Devuelve si lo ha gastado ésta.
 */
export async function consumeEmailCodeAndSetRecoveryEmail(
	db: Base,
	k: EmailCodeKey,
	args: { codeHash: string; email: string | null; nowMs: number },
): Promise<boolean> {
	const recienGastado = `EXISTS (SELECT 1 FROM email_codes
	                               WHERE tenant_id = ?1 AND device_id = ?2 AND purpose = ?3
	                                 AND code_hash = ?4 AND consumed_at_ms = ?5)`;
	const [gastado] = await db.batch([
		{
			sql: `UPDATE email_codes SET consumed_at_ms = ?5
			      WHERE tenant_id = ?1 AND device_id = ?2 AND purpose = ?3 AND code_hash = ?4
			        AND consumed_at_ms IS NULL
			      RETURNING tenant_id;`,
			args: [k.tenantId, k.deviceId, k.purpose, args.codeHash, args.nowMs],
		},
		args.email === null
			? {
					sql: `DELETE FROM tenant_recovery_emails WHERE tenant_id = ?1 AND ${recienGastado};`,
					args: [k.tenantId, k.deviceId, k.purpose, args.codeHash, args.nowMs],
				}
			: {
					sql: `INSERT INTO tenant_recovery_emails (tenant_id, email, verified_at_ms)
					      SELECT ?1, ?6, ?5 WHERE ${recienGastado}
					      ON CONFLICT(tenant_id) DO UPDATE SET
					        email = excluded.email,
					        verified_at_ms = excluded.verified_at_ms;`,
					args: [k.tenantId, k.deviceId, k.purpose, args.codeHash, args.nowMs, args.email],
				},
	]);
	return (gastado.rows?.length ?? 0) > 0;
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
 *
 * AUD-06: devuelve el negocio en el que estaba la fila del equipo (`null` si no tenía), que es lo
 * único que queda de él en cuanto el alta la muda. `/activate` lo usa para avisar a la Main de que
 * su base es de otro negocio.
 */
export async function exigirClaveSiEsDeOtroNegocio(
	db: Sql,
	deviceId: string,
	pubB64: string,
	tenantIdQueAutoriza: string,
): Promise<string | null> {
	const r = await exec(
		db,
		`SELECT tenant_id, device_pubkey_b64 FROM devices WHERE device_id=? LIMIT 1;`,
		[deviceId],
	);
	const row = (r.rows?.[0] as any) || null;
	if (!row) return null;

	const duenyo = String(row.tenant_id || "").trim();
	const registrada = String(row.device_pubkey_b64 || "").trim();

	if (duenyo && duenyo === tenantIdQueAutoriza) return duenyo;
	if (!registrada) throw errorDeClave("device_key_missing");
	if (registrada === pubB64.trim()) return duenyo || null;

	throw errorDeClave("device_key_mismatch");
}

/**
 * AUD-06: ¿este equipo era la Main de `tenantId`, un negocio con alguna licencia, esté como esté
 * (también anulada o caducada), y sin retirar? Es lo que deja en el equipo una base de ese negocio.
 *
 * Quedan fuera:
 * - el negocio que deja a medias una primera activación que falló: no llegó a tener licencia, o
 *   sólo una que lo tiene reservado y no se activó (`activated_at_ms`, AUD-09), y si después se
 *   canjeó, ni eso. Ningún equipo guarda datos suyos;
 * - el retirado (`status = 'deleted'`, `domains/admin/pruebas.ts`), que es lo que deja cada tanda
 *   del E2E: su equipo conserva la identidad y estrena la tanda siguiente con la carpeta de datos
 *   recién borrada;
 * - el equipo que fue Handy de ese negocio: una Handy no guarda base (AUD-01, una tablet que pasa
 *   a ser Main de un negocio nuevo).
 *
 * Se mira antes de que el alta mude la fila.
 */
export async function eraLaMainDeOtroNegocio(db: Sql, deviceId: string, tenantId: string): Promise<boolean> {
	const r = await exec(
		db,
		`SELECT 1
		   FROM devices d
		   JOIN licenses l ON l.tenant_id = d.tenant_id AND l.activated_at_ms IS NOT NULL
		   JOIN tenants t ON t.tenant_id = d.tenant_id
		  WHERE d.device_id = ? AND d.tenant_id = ? AND d.role = 'tpv' AND t.status <> 'deleted'
		  LIMIT 1;`,
		[deviceId, tenantId],
	);
	return (r.rows?.length ?? 0) > 0;
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

/**
 * Las licencias de una sesión de checkout que ya se cumplió, en el orden de sus unidades; ninguna si
 * no se ha cumplido. Es la consulta con la que `emitirCobro` lo decide (`COBROS_DE_LA_SESION`).
 */
export async function licenciasDeUnaSesionCumplida(db: Sql, sessionId: string): Promise<string[]> {
	const r = await exec(db, COBROS_DE_LA_SESION, [sessionId]);
	return (r.rows ?? []).map((f) => String((f as unknown as { license_id: unknown }).license_id));
}

/**
 * Las licencias de la sesión de checkout `sessionId` cobradas antes de `cobradasAntesDeMs` cuyo
 * correo con las claves no consta como entregado (`key_email_sent_at_ms` a NULL), en el orden de sus
 * unidades. Sólo se lee: lo que se haga con ellas lo decide un operador (`pnpm license:resend`).
 */
export async function licenciasSinCorreoDeClaves(db: Sql, sessionId: string, cobradasAntesDeMs: number): Promise<string[]> {
	const r = await exec(
		db,
		`SELECT p.license_id FROM license_payments p JOIN licenses l ON l.license_id = p.license_id
		 WHERE p.stripe_checkout_session_id = ? AND p.at_ms < ? AND l.key_email_sent_at_ms IS NULL
		 ORDER BY p.unidad;`,
		[sessionId, cobradasAntesDeMs],
	);
	return (r.rows ?? []).map((f) => String((f as unknown as { license_id: unknown }).license_id));
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
		| "pruebas_retirar"
		| "huerfanos_retirar"
		// DO-03: la base de un negocio, a mano (`domains/admin/basesDeNegocios.ts`).
		| "negocio_copiar"
		| "negocio_volver_a_instante"
		// DO-PERDIDA: base a un objeto vacío de un negocio que ya nació.
		| "negocio_restaurar_copia"
		| "negocio_base_vacia"
		// DO-PERDIDA: el `inicio` de un log, apuntado antes de abrirlo (`reservarLog`).
		| "negocio_log_reservado"
		// DO-SUBIDA: reabrir la subida completa de la Main.
		| "negocio_subida_reabierta",
	licenseId: string | null,
	detail: Record<string, unknown>,
) {
	await exec(
		db,
		INSERTAR_AUDITORIA,
		argumentosDeLaAuditoria({ auditId: crypto.randomUUID(), accion: action, licenseId, detalle: detail, ahoraMs: Date.now() }),
	);
}
