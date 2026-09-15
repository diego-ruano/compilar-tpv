// src/app/arranque/emparejamiento.ts
//
// Cómo se vincula un Handy a su Main, sin React: leer el código que se escribe o se escanea, y el
// bucle que reclama el emparejamiento, espera a que la Main lo apruebe y guarda el token.
//
// El bucle recibe sus dependencias (el IPC, la nube, si la pantalla sigue viva) en vez de importarlas,
// igual que `recoverySync.ts`: así se prueba con dobles y un reloj falso
// (`test/emparejamientoHandy.test.ts`), y la pantalla sólo lo arranca y pinta lo que devuelve.

import { esError } from "@tpv/client";

/** Cada cuánto se pregunta si la Main ya ha aprobado. */
export const ESPERA_ENTRE_CONSULTAS_MS = 1500;
/** Cuánto se espera la aprobación antes de rendirse. */
export const ESPERA_MAXIMA_APROBACION_MS = 3 * 60 * 1000;

// Los fallos que genera el propio emparejamiento. Acaban tal cual en la pantalla de vinculación,
// delante de quien está vinculando el Handy, así que dicen qué hacer y no llevan códigos internos:
// antes salía, por ejemplo, `pair_timeout_waiting_approval` cuando la Main no aprobaba a tiempo.
const SIN_IDENTIDAD =
	"Este dispositivo todavía no tiene su identidad preparada. Cierra la aplicación, vuelve a abrirla e inténtalo de nuevo.";
const RESPUESTA_INESPERADA =
	"La nube ha respondido algo inesperado al vincular. Inténtalo de nuevo y, si se repite, genera un código nuevo en el TPV principal.";
const SIN_APROBACION =
	"El TPV principal no ha aprobado la vinculación en tres minutos. Vuelve a pulsar «Vincular dispositivo» y apruébala en el TPV principal.";

export type CodigoDeVinculacion = { pairCode: string; pairSecret: string };

/**
 * Lee un código de vinculación: las 6 cifras que se escriben a mano, o la dirección `tpv://pair?…`
 * que lleva el QR de la Main (con su secreto). `null` si no es ninguna de las dos.
 */
export function leerCodigoDeVinculacion(raw: string): CodigoDeVinculacion | null {
	const s = String(raw || "").trim();

	if (/^\d{6}$/.test(s)) return { pairCode: s, pairSecret: "" };
	if (!s.toLowerCase().startsWith("tpv://pair")) return null;

	try {
		const u = new URL(s.replace(/^tpv:\/\//i, "https://"));
		const pairCode = (u.searchParams.get("code") || "").trim();
		const pairSecret = (u.searchParams.get("secret") || "").trim();

		if (!/^\d{6}$/.test(pairCode)) return null;

		return { pairCode, pairSecret };
	} catch {
		return null;
	}
}

/** Lo que se ha escrito en la pantalla: manda el contenido del QR, y si no vale, el código manual. */
export function codigoParaVincular(contenidoQr: string, codigoManual: string): CodigoDeVinculacion | null {
	return (
		leerCodigoDeVinculacion(contenidoQr) ||
		(codigoManual ? leerCodigoDeVinculacion(codigoManual) : null)
	);
}

export type Emparejamiento = { tenantId: string; token: string; deviceId: string };

/** El IPC con Rust (`invokeClient`). */
export type Invocar = <T>(comando: string, args?: Record<string, unknown>) => Promise<T>;

export type DependenciasEmparejamiento = {
	invoke: Invocar;
	/** Una petición anónima al worker (`cloudPost("anon", …)`). */
	pedirALaNube: <T>(ruta: string, cuerpo: unknown) => Promise<T>;
	/** `false` en cuanto la pantalla que lo arrancó se desmonta: el bucle deja de consultar. */
	sigueVivo: () => boolean;
	/** Se llama al reclamar, cuando empieza la espera de la aprobación. */
	alQuedarPendiente: (pendiente: CodigoDeVinculacion & { nonceB64: string; nonceExpiresAtMs: number }) => void;
};

export type Identidad = { deviceId: string; devicePubKeyB64: string };

/** La identidad del equipo con la que se reclama el emparejamiento. Falla si está incompleta. */
export async function identidadDelDispositivo(invoke: Invocar): Promise<Identidad> {
	const r = (await invoke("device_get_identity")) as any;

	const deviceId = String(r.deviceId || r.device_id || "");
	const pub = String(
		r.devicePubkeyB64 ?? r.device_pubkey_b64 ?? r.devicePubKeyB64 ?? r.device_pub_key_b64 ?? "",
	).trim();

	if (!deviceId || !pub || pub.length < 40) throw new Error(SIN_IDENTIDAD);

	return { deviceId, devicePubKeyB64: pub };
}

async function firmar(invoke: Invocar, payload: string): Promise<string> {
	const r = (await invoke("device_sign_b64", { args: { payload } })) as any;
	const sig = String(r.sigB64 ?? r.sig_b64 ?? r.signature ?? "").trim();
	if (!sig) throw new Error(SIN_IDENTIDAD);
	return sig;
}

/**
 * Reclama el emparejamiento con la Main y espera a que lo apruebe.
 *
 * Devuelve el emparejamiento ya guardado (el token queda en el keyring vía `handy_set_token`), o
 * `null` si la pantalla se desmontó mientras esperaba. «Todavía sin aprobar» no es un fallo: se sigue
 * preguntando. Cualquier otro error corta en el acto; los de la nube llegan tal como los da el IPC.
 */
export async function emparejarHandy(
	codigo: CodigoDeVinculacion,
	deps: DependenciasEmparejamiento,
): Promise<Emparejamiento | null> {
	const { pairCode, pairSecret } = codigo;
	const ident = await identidadDelDispositivo(deps.invoke);

	const claim = (await deps.pedirALaNube("/v1/pair/claim", {
		pairCode,
		pairSecret,
		deviceId: ident.deviceId,
		devicePubKey: ident.devicePubKeyB64,
		deviceName: "",
	})) as any;

	const nonceB64 = String(claim.nonceB64 ?? claim.nonce_b64 ?? "");
	const nonceExpiresAtMs = Number(claim.nonceExpiresAtMs ?? claim.nonce_expires_at_ms ?? 0);

	if (!nonceB64 || !Number.isFinite(nonceExpiresAtMs)) {
		throw new Error(RESPUESTA_INESPERADA);
	}

	deps.alQuedarPendiente({ pairCode, pairSecret, nonceB64, nonceExpiresAtMs });

	const empezo = Date.now();

	while (Date.now() - empezo < ESPERA_MAXIMA_APROBACION_MS) {
		await new Promise((r) => setTimeout(r, ESPERA_ENTRE_CONSULTAS_MS));
		if (!deps.sigueVivo()) return null;

		const ts = Date.now();
		const sigB64 = await firmar(deps.invoke, `${ts}\nPAIR_FETCH\n${pairCode}\n${nonceB64}\n${ident.deviceId}`);

		try {
			const ft = (await deps.pedirALaNube("/v1/pair/fetch-token", {
				pairCode,
				deviceId: ident.deviceId,
				nonceB64,
				ts,
				sigB64,
			})) as any;

			const tenantId = String(ft.tenantId ?? ft.tenant_id ?? "");
			const token = String(ft.token ?? "");

			if (!tenantId || !token) {
				throw new Error(RESPUESTA_INESPERADA);
			}

			await deps.invoke("handy_set_token", { args: { token, tenant_id: tenantId } });

			return { tenantId, token, deviceId: ident.deviceId };
		} catch (e: unknown) {
			// ARCH-05: "todavía sin aprobar en la Main" no es un fallo, es que seguimos esperando.
			// Se ramifica por CÓDIGO del catálogo, nunca por el texto del mensaje.
			if (esError(e, "not_approved")) continue;
			throw e;
		}
	}

	if (!deps.sigueVivo()) return null;
	throw new Error(SIN_APROBACION);
}
