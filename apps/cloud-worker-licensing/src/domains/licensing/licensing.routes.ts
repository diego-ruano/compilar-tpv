// src/domains/licensing/licensing.routes.ts
//
// Las cuatro rutas que consume el TPV (cliente Rust en `crates/tpv-infra-licensing`):
//
//   POST /v1/license/activate              → canjea la clave, liga el Main, provisiona el tenant;
//                                            anónima, pero firmada con la clave del equipo
//   POST /v1/license/device-change/request → manda el OTP para mover la licencia a otro equipo
//   GET  /v1/license/status                → estado FIRMADO (ed25519) + token renovado
//   POST /v1/license/refresh               → reemite el token caducado, autenticando por device-proof
//
// La verdad comercial es NUESTRA (tabla `licenses` en la Turso central): ya no se consulta a
// ningún tercero. Y el estado que decide el gate viaja firmado: el TLS deja de ser la única
// barrera (docs/arquitectura/licencias.md).

import { Hono, type Context, type MiddlewareHandler } from "hono";

import type { Env } from "../../env";
import { capturarError } from "../../observability/errors";
import type { ActivateResponse, ApiError, SignedLicenseAssertion, TenantInfo } from "../../shared";
import { enTransaccion, getDb } from "../../server/db";
import { timingSafeEqualHex } from "../../server/utils/crypto";
import {
	activateLicenseFirstTime,
	canjearLicencia,
	exigirLaClaveDeEsteEquipo,
	extendLicense,
	devolverFalloDeOtp,
	devolverIntentoDeOtp,
	reservarEnvioDeOtp,
	reservarFalloDeOtp,
	reservarIntentoDeOtp,
	consumeDeviceOtp,
	ensureDevice,
	ensureTenantExistsMinimal,
	exigirClaveSiEsDeOtroNegocio,
	getDeviceOtp,
	getLicenseByHash,
	getLicenseById,
	putDeviceOtp,
	reassignMainDevice,
	getOrCreateTenantFieldDek,
	licenciaVivaDelDispositivo,
	reasignarCobrosDeLaClave,
	sigueSiendoLaLicenciaDelEquipo,
	upsertTenantInfo,
	type LicenseRow,
} from "../../server/licenseStore";
import { cargarDevice, estaRevocado, normalizarRol } from "../../lib/deviceAuth";
import { avisarCambioDeLicencia } from "../../lib/hub";
import { pasaElLimitador } from "../../lib/limitador";
import { ipDeLaPeticion } from "../pairing/pairing.avisos";
import { cuerpo, topeAnonimo } from "../../lib/validacion";
import { activarSchema, pedirCambioSchema } from "./licensing.schemas";
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
	OTP_CODIGOS_AL_DIA,
	OTP_FALLOS_AL_DIA,
	OTP_MAX_ATTEMPTS,
	OTP_TTL_MS,
	OTP_VENTANA_MS,
	otpHash,
	provisionTenantDatabase,
	stateAllowsUse,
	toBool01,
	readmitirMain,
	cabecerasDeLaFirma,
	verificarFirmaDeActivacion,
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

// AUD-34: las tres anónimas leen el cuerpo antes de saber quién llama (`/refresh`, tras un token sin
// verificar). Su tope, delante de todo.
licenseRoutes.use("/activate", topeAnonimo());
licenseRoutes.use("/device-change/request", topeAnonimo());
licenseRoutes.use("/refresh", topeAnonimo());

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

/**
 * RI-09 · Un rechazo de la licencia que lleva su aserción FIRMADA, la misma que daría `/status`.
 *
 * `/status` ya decía `revoked` o `device_replaced` firmados, pero `/refresh` y la readmisión de una
 * Main contestaban un código suelto, que el cliente no puede comprobar y ya no se cree: lo trata como
 * no haber podido preguntar (gracia offline). Así, a un equipo que llevaba más de 30 días apagado
 * —con el token caducado, que es cuando pasa por aquí— una anulación de verdad le llega igual de
 * firmada y le bloquea en el acto.
 *
 * Si la firma falla (falta la clave), sale el rechazo sin ella: el cliente seguirá con la gracia.
 */
async function rechazoFirmado(
	c: any,
	args: { lic: LicenseRow; claims: ClaimsSesion; error: string; status: 401 | 403 },
) {
	const now = Date.now();
	let assertion: SignedLicenseAssertion | undefined;
	try {
		assertion = await buildSignedAssertion(c.env, {
			lic: args.lic,
			tenantId: args.claims.tenantId,
			deviceId: args.claims.deviceId,
			clientTs: Number(c.req.header("X-Device-Ts") || 0),
			nowMs: now,
		});
	} catch (e: any) {
		capturarError(e, "license.sign_rejection");
		console.error("[license] no se pudo firmar el rechazo:", String(e?.message || e));
	}
	const cuerpo: ApiError & { assertion?: SignedLicenseAssertion; serverTime: number } = {
		ok: false,
		error: args.error,
		assertion,
		serverTime: now,
	};
	return c.json(cuerpo, args.status);
}

/**
 * RI-68 · Filtro por IP delante de las dos rutas anónimas que aceptan una clave de licencia. Recorta
 * el volumen de un barrido; los topes exactos (por licencia) están dentro. Ver `lib/limitador.ts`.
 */
const filtroExterior: MiddlewareHandler<Ctx> = async (c, next) => {
	if (!(await pasaElLimitador(c.env.LIMITADOR_LICENCIA, ipDeLaPeticion(c.req.raw), "license"))) {
		return c.json(
			{
				ok: false,
				error: "too_many_attempts",
				message: "Demasiadas peticiones desde esta red. Vuelve a intentarlo dentro de 1 minuto.",
			} satisfies ApiError,
			429,
		);
	}
	await next();
};

// La tabla de frases (`lib/errorCodes.ts`) manda volver a vincular, que es cosa de una Handy. A quien
// está activando se le dice lo que puede hacer él.
const ACTIVAR_SIN_FIRMA =
	"Esta versión del programa ya no puede activar licencias. Actualízalo y vuelve a intentarlo.";
const ACTIVAR_CON_FIRMA_MALA =
	"No se ha podido comprobar la identidad de este equipo. Vuelve a intentarlo y, si se repite, contacta con soporte.";

/** El 401 de una activación sin prueba de posesión (AUD-01). El de la hora lleva la frase de la tabla. */
function rechazoDeFirma(c: Context, error: string) {
	const message =
		error === "device_ts_out_of_range"
			? undefined
			: error === "missing_device_proof"
				? ACTIVAR_SIN_FIRMA
				: ACTIVAR_CON_FIRMA_MALA;
	return c.json({ ok: false, error, message } satisfies ApiError, 401);
}

/**
 * AUD-07 · Lo que se le dice a quien teclea una clave ya canjeada, además de `license_already_used`.
 *
 * Lo normal es que sea el mismo equipo repitiendo un canje que ya salió bien (la respuesta no le
 * llegó, o ha pulsado dos veces): a ése se le dice que su tiempo ya está sumado, para que no crea
 * que no se aplicó. A cualquier otro, la frase de la tabla: la clave se sumó a otra licencia.
 */
async function fraseDeClaveYaCanjeada(
	db: ReturnType<typeof getDb>,
	clave: LicenseRow,
	deviceId: string,
): Promise<string | undefined> {
	if (!clave.redeemed_into_license_id) return undefined;
	const receptora = await getLicenseById(db, clave.redeemed_into_license_id);
	return receptora?.main_device_id === deviceId
		? "Esa clave ya se ha usado: su tiempo ya está sumado a la licencia de este equipo."
		: undefined;
}

/**
 * El 409 de una clave que no es la registrada (`device_key_mismatch`) o de un equipo registrado sin
 * ninguna (`device_key_missing`). `null` si el fallo es otro, que sigue su camino.
 */
function rechazoPorLaClave(c: Context, e: any) {
	const error = e?.code;
	if (error !== "device_key_mismatch" && error !== "device_key_missing") return null;
	return c.json({ ok: false, error } satisfies ApiError, 409);
}

/**
 * AUD-01 · Activar exige demostrar que se tiene la clave privada del equipo. Va en dos pasos porque
 * la clave pública con la que se comprueba la firma viaja en el cuerpo.
 *
 * Éste va DELANTE del validador: sin las cabeceras de la firma, o con su hora fuera de margen, no se
 * lee el cuerpo. Y deja leídos sus bytes tal como llegaron, que es lo que cubre la firma: el
 * validador los lee después como texto.
 */
const exigirFirma: MiddlewareHandler<Ctx> = async (c, next) => {
	const cabeceras = cabecerasDeLaFirma(c.req.raw);
	if (!cabeceras.ok) return rechazoDeFirma(c, cabeceras.error);
	await c.req.arrayBuffer();
	await next();
};

/**
 * AUD-01 · El segundo paso, DETRÁS del validador y antes de que el handler lea una sola fila: la
 * firma tiene que ser de la clave pública que presenta el cuerpo. Sin ella no se mira ni si la
 * licencia existe, así que tampoco se mueve la fila del equipo, se gasta la clave, se entrega la DEK
 * o se cuenta un intento del código de traslado.
 */
const firmaDelEquipo: MiddlewareHandler<Ctx, string, { out: { json: { devicePubKey: string } } }> = async (
	c,
	next,
) => {
	const firma = await verificarFirmaDeActivacion(
		c.req.raw,
		c.req.valid("json").devicePubKey,
		new Uint8Array(await c.req.arrayBuffer()),
	);
	if (!firma.ok) return rechazoDeFirma(c, firma.error);
	await next();
};

/** El rechazo de `readmitirMain`, firmado cuando es un traslado (la licencia existe). */
async function rechazoDeReadmision(
	c: any,
	db: ReturnType<typeof getDb>,
	claims: ClaimsSesion,
	readmision: { status: 401 | 403; error: string },
) {
	if (readmision.error === "device_replaced") {
		const lic = await getLicenseByHash(db, claims.licHash);
		if (lic) return rechazoFirmado(c, { lic, claims, error: readmision.error, status: readmision.status });
	}
	return c.json({ ok: false, error: readmision.error } satisfies ApiError, readmision.status);
}

// ──────────────────────────────────────────────────────────────────────────────
// POST /v1/license/activate
// ──────────────────────────────────────────────────────────────────────────────

licenseRoutes.post("/activate", filtroExterior, exigirFirma, cuerpo(activarSchema), firmaDelEquipo, async (c) => {
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

	const body = c.req.valid("json");
	const activationKey = normalizeLicenseKey(body.activationKey);
	if (!activationKey) {
		return c.json({ ok: false, error: "license_not_found" } satisfies ApiError, 404);
	}
	const { deviceId, devicePubKey } = body;
	const deviceChangeCode = body.deviceChangeCode ?? "";
	const tenantInfo: TenantInfo = body.tenantInfo ?? {};

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

	// ── La clave del equipo, antes de nada que escriba (REV-07, REV-13, AUD-01) ────────────────
	//
	// Si la nube ya conoce este `device_id`, la clave presentada —que llega firmada con su privada
	// (`firmaDelEquipo`)— tiene que ser la que tiene registrada, esté su fila en el negocio que esté.
	// Una fila sin clave registrada no se da por buena con la que llegue: la firma sólo prueba la
	// clave presentada.
	//
	// Va aquí, delante del canje y del código de traslado, para que el rechazo no deje nada hecho.
	// Se comparaba después de consumir el código y de mudar la fila: con la licencia y el código
	// buenos pero otra clave, contestaba `device_key_mismatch` con el código gastado y, si el equipo
	// era una Handy del propio negocio, con su fila ya de rol `tpv` y sin revocar.
	let equipo: { tenantId: string } | null;
	try {
		equipo = await exigirLaClaveDeEsteEquipo(db, deviceId, devicePubKey);
	} catch (e: any) {
		const rechazo = rechazoPorLaClave(c, e);
		if (rechazo) return rechazo;
		throw e;
	}

	// AUD-01 · El negocio de un equipo es el de su fila de `devices`: lo que la nube tiene
	// registrado, no lo que diga la petición. Si el equipo dice tener otro (`tenantActual`, dentro
	// del cuerpo firmado), no se sigue. Con licencias de dos negocios apuntando a él, bastaba con
	// nombrar el otro para canjear sobre su licencia y recibir su DEK y su token.
	if (body.tenantActual && equipo && body.tenantActual !== equipo.tenantId) {
		return c.json({ ok: false, error: "device_tenant_mismatch" } satisfies ApiError, 409);
	}

	// AUD-07 · Una clave sin Main sólo vale si sigue sin estrenar (`issued`). Un canje la deja
	// `redeemed` con `main_device_id` a NULL, y aquí sólo se miraba esto último: la misma clave
	// estrenaba después un negocio nuevo, con su plazo entero, en cualquier equipo sin licencia
	// viva. El primer local se quedaba los meses sumados, y un reembolso sólo se los restaba a él.
	// Se rechaza antes de elegir camino.
	if (esPrimeraActivacion && lic.status !== "issued") {
		const message = await fraseDeClaveYaCanjeada(db, lic, deviceId);
		return c.json({ ok: false, error: "license_already_used", message } satisfies ApiError, 409);
	}

	// La licencia viva de la que este equipo es la Main EN SU NEGOCIO, si la clave está sin estrenar:
	// es a la que una clave nueva le suma tiempo (REV-13). Sin mirar el negocio, con dos licencias
	// apuntando al equipo se elegía la que más tarde caduca y la Main recibía el negocio de la otra.
	//
	// Se lee UNA vez. Eran dos lecturas, la del veto de `soloSumar` y la del canje: si la licencia
	// se anulaba o se trasladaba entre las dos, la segunda ya no la encontraba y la clave seguía
	// hasta estrenar un negocio nuevo, también con `soloSumar`. Un equipo sin fila no tiene negocio
	// registrado; se pregunta sin él sólo para rechazarlo en el canje.
	const actual = esPrimeraActivacion
		? await licenciaVivaDelDispositivo(db, deviceId, equipo?.tenantId)
		: null;

	const noCanjeable = (message: string) =>
		c.json({ ok: false, error: "clave_no_canjeable", message } satisfies ApiError, 409);

	// RI-52 · Canje desde Configuración → Licencia: el TPV ya está en marcha y sólo quiere sumar el
	// tiempo de otra clave. Todo lo demás que haría esta ruta con esa clave sería un desastre desde
	// ahí: con la clave de otro local ya activada, pedir el código y MOVER aquella licencia a este
	// equipo; con este equipo sin licencia viva, estrenar un negocio nuevo y dejar el suyo atrás. Así
	// que se rechaza antes de tocar nada, con la frase de cada caso.
	if (body?.soloSumar === true) {
		if (esMismoEquipo) return noCanjeable("Esa es la clave que ya tiene este equipo.");
		if (!esPrimeraActivacion) {
			return noCanjeable(
				"Esa clave ya está activada en otro equipo. Aquí sólo se pueden añadir claves sin estrenar.",
			);
		}
		// Sin licencia a la que sumar, de aquí no se pasa. Con ella, lo que sigue es el canje, que
		// suma o rechaza sin gastar la clave: con `soloSumar` no se llega nunca al alta.
		if (!actual) {
			return noCanjeable("Este equipo no tiene una licencia a la que sumarle tiempo.");
		}
	}

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
		if (actual) {
			// La identidad del equipo se comprueba ANTES de gastar la clave: sin esto bastaría con
			// saber un `device_id` ajeno —que viaja en los mensajes de presencia del WebSocket,
			// REV-07— para sumarle meses a la licencia de otro. No es robar, pero tampoco es lo que
			// quiere quien ha pagado.
			//
			// La clave ya se ha comparado arriba con la registrada (`exigirLaClaveDeEsteEquipo`). Lo
			// que falta por exigir aquí es que haya con qué compararla: la Main de una licencia viva
			// tiene su fila, y si no la tiene no hay nada que pruebe que quien firma es ese equipo.
			if (!equipo) {
				return c.json({ ok: false, error: "device_key_missing" } satisfies ApiError, 409);
			}

			const tenantId = actual.tenant_id || "";

			// Lo que la respuesta necesita y puede fallar sin escribir nada va ANTES de gastar la
			// clave. Iba después, y un fallo aquí —la DEK guardada que no se deja descifrar porque
			// `LICENSE_STORE_KEY` ya no es la que la cifró— dejaba la clave gastada y los meses
			// sumados sin que el equipo recibiera su token: el reintento contestaba
			// `license_already_used` y el TPV se quedaba sin poder entrar con ninguna de las dos.
			const fieldDek = await getOrCreateTenantFieldDek(db, env, tenantId);
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
			const canje = await enTransaccion(db, async (tx) => {
				// AUD-01: la licencia se eligió fuera de la transacción. Si entretanto se ha anulado o
				// se ha trasladado a otro equipo, la clave no se gasta sobre ella.
				if (!(await sigueSiendoLaLicenciaDelEquipo(tx, actual.license_id, deviceId))) {
					return "sin_licencia" as const;
				}
				if (!(await canjearLicencia(tx, lic.license_id, actual.license_id))) return "usada" as const;
				const hasta = await extendLicense(tx, actual.license_id, lic.term_months);
				// LIC-07: el cobro se muda con el tiempo, o un reembolso no tendría de dónde restar.
				await reasignarCobrosDeLaClave(tx, lic.license_id, actual.license_id);
				return hasta;
			});
			if (canje === "sin_licencia") {
				return noCanjeable(
					"Este equipo ya no tiene una licencia a la que sumarle tiempo. La clave no se ha gastado: comprueba la licencia y vuelve a intentarlo.",
				);
			}
			if (canje === "usada") {
				// Otra petición la ha canjeado entretanto. Si ha sido este mismo equipo (un doble
				// envío), se le dice que su tiempo ya está sumado (AUD-07).
				const gastada = await getLicenseByHash(db, licHash);
				const message = gastada ? await fraseDeClaveYaCanjeada(db, gastada, deviceId) : undefined;
				return c.json({ ok: false, error: "license_already_used", message } satisfies ApiError, 409);
			}
			const expiresAtMs = canje;

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

	// ── Cambio de equipo: exige el OTP del email ──────────────────────────
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

		// AUD-04: los dos topes se RESERVAN antes de comparar, cada uno en una sola sentencia que sólo
		// concede si queda cupo. Leyendo el contador, comparando y anotando después, las peticiones
		// que llegaban a la vez leían todas antes de que escribiera ninguna y se comparaban todas, y
		// la que acertaba se llevaba la Main. Quien no reserva sale sin que se compare nada.
		const reserva = await reservarIntentoDeOtp(db, {
			licenseId: lic.license_id,
			newDeviceId: deviceId,
			ahoraMs: now,
			maximo: OTP_MAX_ATTEMPTS,
		});
		if (!reserva) {
			// Sólo queda decir por qué. Esta lectura ya no decide nada.
			const otp = await getDeviceOtp(db, lic.license_id, deviceId);
			if (otp && !otp.consumed_at_ms) {
				if (otp.attempts >= OTP_MAX_ATTEMPTS) {
					return c.json({ ok: false, error: "too_many_attempts" } satisfies ApiError, 429);
				}
				if (now > otp.expires_at_ms) {
					return c.json({ ok: false, error: "code_expired" } satisfies ApiError, 401);
				}
			}
			return c.json({ ok: false, error: "invalid_code" } satisfies ApiError, 401);
		}
		// RI-68: el tope de verdad es por LICENCIA, no por código: pedir otro código o inventarse otro
		// `deviceId` daban intentos nuevos sin fin.
		const quedanFallos = await reservarFalloDeOtp(db, {
			licenseId: lic.license_id,
			ahoraMs: now,
			ventanaMs: OTP_VENTANA_MS,
			maximo: OTP_FALLOS_AL_DIA,
		});
		if (!quedanFallos) {
			// No se va a comparar nada, así que el intento del código se devuelve: el rechazo del día
			// no puede dejar sin intentos un código que seguirá valiendo cuando el día se libere.
			await devolverIntentoDeOtp(db, {
				licenseId: lic.license_id,
				newDeviceId: deviceId,
				codeHash: reserva.codeHash,
			});
			return c.json(
				{
					ok: false,
					error: "too_many_attempts",
					message:
						"Se han tecleado demasiados códigos incorrectos para esta licencia. Vuelve a intentarlo mañana o contacta con soporte.",
				} satisfies ApiError,
				429,
			);
		}

		const presentado = await otpHash(deviceChangeCode);
		if (!timingSafeEqualHex(presentado, reserva.codeHash)) {
			// El intento y el fallo del día ya están anotados: son las dos reservas.
			return c.json({ ok: false, error: "invalid_code" } satisfies ApiError, 401);
		}

		// El código es el bueno, así que su reserva no es un fallo del día. Se devuelve ANTES de
		// consumirlo: si esta sentencia fallara, el código sigue vivo y basta con reintentar.
		await devolverFalloDeOtp(db, lic.license_id, now);

		// Consumo atómico: si dos peticiones llegan a la vez con el código bueno, solo una gana.
		const consumido = await consumeDeviceOtp(db, lic.license_id, deviceId, reserva.codeHash);
		if (!consumido) {
			return c.json({ ok: false, error: "invalid_code" } satisfies ApiError, 401);
		}
	}

	// ── Tenant + dispositivo ────────────────────────────────────────────────
	const tenantId = lic.tenant_id || crypto.randomUUID();

	try {
		// REV-07: la comprobación va PRIMERO, y ahí estaba el fallo. `ensureDevice` hace un
		// `ON CONFLICT(device_id) DO UPDATE` que mueve la fila al tenant de quien activa, y sólo
		// después se miraba la clave — con una consulta filtrada por el tenant NUEVO, o sea sobre la
		// fila ya movida—. Resultado: presentando una licencia propia y el `device_id` ajeno, la
		// Main de otro negocio se quedaba con su fila en un tenant que no es el suyo. Ahora, si ese
		// `device_id` ya tiene clave registrada en cualquier negocio y no es ésta, no se toca nada.
		// Y presentar la registrada exige tener su privada: la petición llega firmada con ella
		// (AUD-01, `firmaDelEquipo`).
		await exigirClaveSiEsDeOtroNegocio(db, deviceId, devicePubKey, tenantId);

		// El negocio se crea (o se toca) después de esa comprobación y no antes: si rechaza, no
		// queda ni un tenant recién creado ni su `updated_at_ms` movido. Tiene que ir delante del
		// alta, que apunta a él.
		await ensureTenantExistsMinimal(db, tenantId);

		// Da de alta el dispositivo con su clave, o muda su fila, en UNA sentencia (AUD-01): la
		// fila nace con clave, y una que ya existe sólo se toca si la registrada es ésta. Si no
		// lo es, lanza `device_key_mismatch` sin haber escrito la fila.
		await ensureDevice(db, tenantId, deviceId, "tpv", devicePubKey);
	} catch (e: any) {
		const rechazo = rechazoPorLaClave(c, e);
		if (rechazo) return rechazo;
		throw e;
	}

	try {
		await provisionTenantDatabase(db, env, tenantId);
	} catch (e: any) {
		capturarError(e, "license.provision");
		const detalle = String(e?.message || e);
		// Al log (visible con `wrangler tail`): el detalle de Turso es la clave para diagnosticar
		// (401 = token de plataforma malo, 404 = org/grupo inexistente, límite de plan, etc.). A la
		// respuesta no va (FABLE-B): es el texto crudo de la API de plataforma de Turso.
		console.error("[activate] tenant_db_provision_failed:", detalle);
		return c.json({ ok: false, error: "tenant_db_provision_failed" } satisfies ApiError, 500);
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
			// AUD-07: o la ha activado otro equipo, o la ha canjeado otro mientras éste aprovisionaba
			// su base. En el segundo caso la clave sigue sin Main: no está en otro equipo, está usada.
			const ganada = await getLicenseByHash(db, licHash);
			if (ganada && !ganada.main_device_id) {
				return c.json({ ok: false, error: "license_already_used" } satisfies ApiError, 409);
			}
			return c.json({ ok: false, error: "device_replaced" } satisfies ApiError, 409);
		}
		expiresAtMs = activada;
	} else if (esCambioDeEquipo) {
		await reassignMainDevice(db, {
			licenseId: lic.license_id,
			fromDeviceId: lic.main_device_id,
			toDeviceId: deviceId,
		});

		// AUD-02: y el equipo anterior deja de ser Main también en el `TenantHub`. Su socket seguía
		// abierto con el rol `tpv` de cuando saludó, mandando SQL que la nube confirmaba y este
		// equipo ejecutaba, y recibiendo todo lo del negocio. Después de cambiar la licencia, para
		// que lo que lea el hub sea ya este equipo y al reconectar se le niegue el ticket al
		// anterior. No nombra a quién echar: el hub vuelve a leer quién es la Main, y un aviso que
		// llegue tarde no echa a la que haya vuelto a serlo. Best-effort: si no llega, el hub lo
		// corrige cuando salude este equipo o en cuanto haya actividad en el negocio.
		await avisarCambioDeLicencia(env.TenantHub, tenantId);

		// Aviso al titular: si el cambio no lo ha hecho él, queremos que se entere HOY.
		// No bloquea la activación: el correo es entrega, no autorización.
		c.executionCtx.waitUntil(sendDeviceChangedNoticeEmail(env, { to: lic.customer_email }));
	}

	const token = await firmarSesion(env, { tenantId, deviceId, licHash });

	// TRAB-03: la clave con la que la Main cifra DNI/IBAN/nº SS. Se entrega en cada
	// activación (no sólo en la primera) porque es justo lo que necesita un equipo nuevo
	// tras un cambio de dispositivo para poder volver a leer los datos del personal.
	const fieldDek = await getOrCreateTenantFieldDek(db, env, tenantId);

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

licenseRoutes.post("/device-change/request", filtroExterior, cuerpo(pedirCambioSchema), async (c) => {
	const env = c.env;
	const miss = assertEnv(env, ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN", "EMAIL_FROM_ADDRESS"]);
	if (miss) return c.json({ ok: false, error: miss } satisfies ApiError, 500);

	const body = c.req.valid("json");
	const activationKey = normalizeLicenseKey(body.activationKey);
	const deviceId = body.deviceId;

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

	// RI-68: y como mucho OTP_CODIGOS_AL_DIA por licencia, vengan del equipo que vengan. El de arriba
	// es por pareja, y un `deviceId` inventado abre otra. Pasado el tope se contesta igual, sin enviar.
	const quedaCupo = await reservarEnvioDeOtp(db, {
		licenseId: lic.license_id,
		ahoraMs: now,
		ventanaMs: OTP_VENTANA_MS,
		maximo: OTP_CODIGOS_AL_DIA,
	});
	if (!quedaCupo) return respuestaConstante;

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
			return rechazoDeReadmision(c, db, claims, readmision);
		}
	} else if (!proof.ok) {
		return c.json({ ok: false, error: proof.error } satisfies ApiError, 401);
	}

	const lic = await getLicenseByHash(db, claims.licHash);
	if (!lic) return c.json({ ok: false, error: "license_not_found" } satisfies ApiError, 404);
	// AUD-03: como en `/refresh`, la licencia tiene que ser la de su negocio. Un token con el `licHash`
	// de otra fila recibía aquí una aserción firmada de esa licencia, un token renovado y su correo.
	if (lic.tenant_id !== claims.tenantId) {
		return c.json({ ok: false, error: "license_not_found" } satisfies ApiError, 404);
	}

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
			return rechazoDeReadmision(c, db, claims, readmision);
		}
	} else if (!proof.ok) {
		return c.json({ ok: false, error: proof.error } satisfies ApiError, 401);
	}

	const lic = await getLicenseByHash(db, claims.licHash);
	if (!lic) return c.json({ ok: false, error: "license_not_found" } satisfies ApiError, 404);
	// AUD-03: la licencia tiene que ser la de su negocio. Los claims se leen sin verificar, así que el
	// `licHash` lo elige quien llama, y el device-proof sólo ata tenant y dispositivo: sin esto, una
	// Handy de un negocio con la licencia anulada o caducada salía con un token firmado hacia otra
	// fila (una clave suya sin estrenar o ya canjeada) y se saltaba REV-12. Se contesta como si no
	// existiera y sin aserción firmada, que hablaría de una licencia ajena.
	if (lic.tenant_id !== claims.tenantId) {
		return c.json({ ok: false, error: "license_not_found" } satisfies ApiError, 404);
	}
	if (estaAnulada(lic)) {
		return rechazoFirmado(c, { lic, claims, error: "license_revoked", status: 403 });
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
		return rechazoFirmado(c, { lic, claims, error: "device_replaced", status: 403 });
	}

	const token = await firmarSesion(env, claims);
	return c.json({ ok: true, token });
});
