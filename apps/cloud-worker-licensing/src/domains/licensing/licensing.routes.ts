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
import { enTransaccion, getDb } from "../../server/db";
import { timingSafeEqualHex } from "../../server/utils/crypto";
import {
	activateLicenseFirstTime,
	canjearLicencia,
	exigirLaClaveDeEsteEquipo,
	extendLicense,
	bumpDeviceOtpAttempts,
	consumeDeviceOtp,
	ensureDevice,
	ensureTenantExistsMinimal,
	exigirClaveSiEsDeOtroNegocio,
	getDeviceOtp,
	getLicenseByHash,
	putDeviceOtp,
	reassignMainDevice,
	getOrCreateTenantFieldDek,
	licenciaVivaDelDispositivo,
	reasignarCobrosDeLaClave,
	setDevicePubKeyB64IfEmptyOrThrow,
	upsertTenantInfo,
	type LicenseRow,
} from "../../server/licenseStore";
import { cargarDevice, estaRevocado, normalizarRol } from "../../lib/deviceAuth";
import { licenseKeyHash, normalizeLicenseKey } from "./licenseKey";
import {
	sendDeviceChangeCodeEmail,
	sendDeviceChangedNoticeEmail,
	sendLicenseRenewedEmail,
} from "./licenseEmails";
import {
	assertEnv,
	buildSignedAssertion,
	computeLicenseState,
	emailHint,
	generateOtpCode,
	GRACE_DAYS,
	OTP_MAX_ATTEMPTS,
	OTP_TTL_MS,
	otpHash,
	provisionTenantDatabase,
	stateAllowsUse,
	toBool01,
	readmitirMain,
	verifyDeviceProof,
} from "./licensing.helpers";
import {
	type ClaimsSesion,
	firmarSesion,
	handyTokenTtlSeconds,
	leerBearer,
	leerClaimsSinVerificar,
	verificarSesion,
} from "../../lib/sesion";

type Ctx = { Bindings: Env };

export const licenseRoutes = new Hono<Ctx>();

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

	// ── REV-13 · Canjear: una clave sin estrenar SUMA tiempo al negocio que este equipo ya tiene ──
	//
	// El mismo enlace de compra sirve para estrenar y para renovar, y lo que decide cuál es de las
	// dos no es por dónde se compró: es lo que el TPV ya tiene cuando se teclea el código. Antes se
	// adivinaba en el webhook de Stripe por el cliente que pagaba —así que comprar con los mismos
	// datos era lo que disparaba la renovación, y el dueño de un segundo local pagaba y no recibía
	// clave—. Aquí no hay nada que adivinar: o este equipo ya es la Main de una licencia, o no.
	//
	// Va ANTES de resolver el tenant a propósito: canjear no crea nada. Ni tenant, ni base en
	// Turso, ni DEK. El negocio sigue siendo el mismo con más meses por delante, que es justo lo
	// que hace que esto no pueda perder datos.
	//
	// Y sólo entra por aquí una clave **sin estrenar**: una licencia ya activada no suma tiempo.
	// Moverla a otro local es un cambio de equipo, que recicla la que hay y tiene su propio camino.
	if (esPrimeraActivacion) {
		const actual = await licenciaVivaDelDispositivo(db, deviceId);

		if (actual) {
			// La identidad del equipo se comprueba ANTES de gastar la clave: sin esto bastaría con
			// saber un `device_id` ajeno —que viaja en los mensajes de presencia del WebSocket,
			// REV-07— para sumarle meses a la licencia de otro. No es robar, pero tampoco es lo que
			// quiere quien ha pagado.
			//
			// Y no vale `exigirClaveSiEsDeOtroNegocio`: aquél se aparta en cuanto el dispositivo es
			// del tenant que autoriza, que es exactamente este caso.
			try {
				await exigirLaClaveDeEsteEquipo(db, deviceId, devicePubKey);
			} catch (e: any) {
				if (e?.code === "device_key_mismatch") {
					return c.json({ ok: false, error: "device_key_mismatch" } satisfies ApiError, 409);
				}
				throw e;
			}

			const tenantId = actual.tenant_id || "";

			// Lo que la respuesta necesita y puede fallar sin escribir nada va ANTES de gastar la
			// clave. Iba después, y un fallo aquí —la DEK guardada que no se deja descifrar porque
			// `LICENSE_STORE_KEY` ya no es la que la cifró— dejaba la clave gastada y los meses
			// sumados sin que el equipo recibiera su token: el reintento contestaba
			// `license_already_used` y el TPV se quedaba sin poder entrar con ninguna de las dos.
			const fieldDek = await getOrCreateTenantFieldDek(db, env.LICENSE_STORE_KEY, tenantId);
			// El token lleva el hash de la licencia que SIGUE viva, no el de la clave gastada: es
			// con lo que `/status` la reconoce a partir de ahora.
			const token = await firmarSesion(env, {
				tenantId,
				deviceId,
				licHash: actual.license_key_hash,
			});

			// Gastar la clave, sumar sus meses y mudar su cobro van juntos o no van (REV-01): con
			// sentencias sueltas, un corte a mitad dejaba la clave gastada sin haber sumado nada. Y
			// en este orden: si el canje no gana la carrera, no se ha sumado nada.
			const expiresAtMs = await enTransaccion(db, async (tx) => {
				if (!(await canjearLicencia(tx, lic.license_id, actual.license_id))) return null;
				const hasta = await extendLicense(tx, actual.license_id, lic.term_months);
				// LIC-07: el cobro se muda con el tiempo, o un reembolso no tendría de dónde restar.
				await reasignarCobrosDeLaClave(tx, lic.license_id, actual.license_id);
				return hasta;
			});
			if (expiresAtMs === null) {
				return c.json({ ok: false, error: "license_already_used" } satisfies ApiError, 409);
			}

			// Recibo. No bloquea nada —quien ha canjeado está delante del TPV y ya lo ve en
			// pantalla—, pero deja constancia en su correo de cuánto se sumó y hasta cuándo.
			c.executionCtx.waitUntil(
				sendLicenseRenewedEmail(env, {
					to: actual.customer_email,
					name: actual.customer_name,
					termMonths: lic.term_months,
					expiresAtMs,
				}),
			);

			const out: ActivateResponse = {
				ok: true,
				tenantId,
				deviceId,
				token,
				status: "active",
				expiresAt: expiresAtMs ? new Date(expiresAtMs).toISOString() : null,
				fieldDek,
				cambioDeEquipo: false,
				tiempoSumado: true,
			};
			return c.json(out);
		}
	}

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
		// REV-07: la comprobación va PRIMERO, y ahí estaba el fallo. `ensureDevice` hace un
		// `ON CONFLICT(device_id) DO UPDATE` que mueve la fila al tenant de quien activa, y sólo
		// después se miraba la clave — con una consulta filtrada por el tenant NUEVO, o sea sobre la
		// fila ya movida—. Resultado: presentando una licencia propia y el `device_id` ajeno, la
		// Main de otro negocio se quedaba con su fila en un tenant que no es el suyo. Ahora, si ese
		// `device_id` ya tiene clave registrada en cualquier negocio y no es ésta, no se toca nada.
		await exigirClaveSiEsDeOtroNegocio(db, deviceId, devicePubKey, tenantId);

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
		// LOGIN-08: la activación ya no pregunta un correo. El de recuperación es el de la compra
		// hasta que alguien lo cambie verificándolo; ver `domains/login/correoRecuperacion.ts`.
		phone: tenantInfo.phone ?? null,
		country: tenantInfo.country ?? null,
	});

	// ── Licencia: arrancar el reloj o mover el Main ─────────────────────────
	let expiresAtMs = lic.expires_at_ms;

	if (esPrimeraActivacion) {
		const activada = await activateLicenseFirstTime(db, {
			licenseId: lic.license_id,
			tenantId,
			deviceId,
			termMonths: lic.term_months,
		});

		// REV-15: dos equipos activando la misma clave a la vez. El `UPDATE` va condicionado a que
		// siga sin activar, así que sólo uno gana — pero nadie miraba si había ganado, y la
		// perdedora seguía hasta el final: se llevaba un token y la DEK de un tenant que la
		// licencia no apunta. Dos equipos creyéndose la Main del mismo negocio, cada uno con su
		// base, y ninguno de los dos enterándose.
		//
		// A la perdedora se le dice lo mismo que a cualquier equipo que llega tarde a una licencia
		// ya activada: está en otro sitio. Lo que sí queda detrás es la base de Turso que se
		// aprovisionó unas líneas más arriba, vacía y sin dueño; moverlo todo por delante del
		// aprovisionamiento lo evitaría, pero dejaría la licencia atada a un equipo cuya base falló
		// al crearse, y eso es peor que una base de sobra.
		if (activada === null) {
			return c.json({ ok: false, error: "device_replaced" } satisfies ApiError, 409);
		}
		expiresAtMs = activada;
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

	const token = await firmarSesion(env, { tenantId, deviceId, licHash });

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
		cambioDeEquipo: esCambioDeEquipo,
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

	const bearer = leerBearer(c.req.raw);
	if (!bearer) return c.json({ ok: false, error: "missing_token" } satisfies ApiError, 401);

	let claims: ClaimsSesion;
	try {
		claims = await verificarSesion(env, bearer);
	} catch {
		// Token caducado o inválido. El cliente NO debe borrar la licencia por esto: debe
		// intentar /refresh (device-proof). Se lo decimos explícitamente en el código de error.
		return c.json({ ok: false, error: "token_expired" } satisfies ApiError, 401);
	}

	const db = getDb(env);

	const rawBody = c.req.raw.body
		? new Uint8Array(await c.req.arrayBuffer())
		: new Uint8Array();
	const proof = await verifyDeviceProof(
		c.req.raw,
		db,
		{ tenantId: claims.tenantId, deviceId: claims.deviceId },
		undefined,
		rawBody,
	);
	if (!proof.ok && proof.error === "device_pubkey_not_registered") {
		// Una Main cuya fila pasó a otro negocio (se usó como Handy): se la vuelve a dar de alta.
		const readmision = await readmitirMain(c.req.raw, db, claims, rawBody);
		if (!readmision.ok) {
			return c.json({ ok: false, error: readmision.error } satisfies ApiError, readmision.status);
		}
	} else if (!proof.ok) {
		return c.json({ ok: false, error: proof.error } satisfies ApiError, 401);
	}

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
	//
	// REV-12: pero sólo si la licencia deja trabajar. Se renovaba siempre, incluso anulada, de modo
	// que el equipo conservaba indefinidamente una credencial buena para todo lo que no fuera esta
	// ruta. `warn` y `expiry_grace` sí renuevan, que es lo que permite seguir vendiendo y
	// replicando durante la gracia.
	//
	// Esta ruta contesta igual pase lo que pase: es por donde el cliente se ENTERA de que su
	// licencia ha dejado de valer, así que callarla lo dejaría sin saberlo. Lo que se le niega es
	// el token nuevo, no la respuesta.
	const estadoActual = computeLicenseState(lic, claims.deviceId, now);
	const token = stateAllowsUse(estadoActual) ? await firmarSesion(env, claims) : undefined;

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

	const bearer = leerBearer(c.req.raw);
	if (!bearer) return c.json({ ok: false, error: "missing_token" } satisfies ApiError, 401);

	const claims = leerClaimsSinVerificar(bearer);
	if (!claims) return c.json({ ok: false, error: "invalid_token" } satisfies ApiError, 401);

	const db = getDb(env);

	const rawBody = c.req.raw.body
		? new Uint8Array(await c.req.arrayBuffer())
		: new Uint8Array();
	const proof = await verifyDeviceProof(
		c.req.raw,
		db,
		{ tenantId: claims.tenantId, deviceId: claims.deviceId },
		undefined,
		rawBody,
	);
	if (!proof.ok && proof.error === "device_pubkey_not_registered") {
		// Una Main cuya fila pasó a otro negocio (se usó como Handy): se la vuelve a dar de alta.
		const readmision = await readmitirMain(c.req.raw, db, claims, rawBody);
		if (!readmision.ok) {
			return c.json({ ok: false, error: readmision.error } satisfies ApiError, readmision.status);
		}
	} else if (!proof.ok) {
		return c.json({ ok: false, error: proof.error } satisfies ApiError, 401);
	}

	const lic = await getLicenseByHash(db, claims.licHash);
	if (!lic) return c.json({ ok: false, error: "license_not_found" } satisfies ApiError, 404);
	if (estaAnulada(lic)) {
		return c.json({ ok: false, error: "license_revoked" } satisfies ApiError, 403);
	}

	// El rol sale de la FILA, nunca del token (ver `tenant.ts`). Y hay que preguntarlo aquí porque
	// de él dependen las dos cosas que siguen: una Handy no es —ni puede ser— el `main_device_id`
	// de la licencia, así que la comprobación de traslado la daría por desplazada SIEMPRE, y su
	// token no vive lo mismo que el de la Main.
	const fila = await cargarDevice(db, claims.tenantId, claims.deviceId);

	// Un dispositivo revocado no merece un token nuevo. Antes se le daba: era inútil (todo lo
	// demás vuelve a mirar la fila y le contesta `device_revoked`), pero le hacía creer que el
	// problema se había arreglado y volvía a intentarlo contra la misma pared.
	if (fila && estaRevocado(fila)) {
		return c.json({ ok: false, error: "device_revoked" } satisfies ApiError, 401);
	}

	if (normalizarRol(fila?.role) === "handy") {
		// REV-02: el token de la Handy se emite al emparejar y NADA lo renovaba: a los 30 días dejaba de
		// funcionar y había que volver a vincularla a mano. Aquí se reemite con la misma llave que
		// autentica todo lo demás —la firma de su clave privada, que ya se ha comprobado arriba—,
		// que es lo que hace que un token caducado no sea un callejón sin salida.
		const token = await firmarSesion(env, claims, {
			rol: "handy",
			ttlSegundos: handyTokenTtlSeconds(env),
		});
		return c.json({ ok: true, token });
	}

	// Si la licencia ya se movió a otro Main, este equipo no merece un token nuevo.
	if (computeLicenseState(lic, claims.deviceId, Date.now()) === "device_replaced") {
		return c.json({ ok: false, error: "device_replaced" } satisfies ApiError, 403);
	}

	const token = await firmarSesion(env, claims);
	return c.json({ ok: true, token });
});
