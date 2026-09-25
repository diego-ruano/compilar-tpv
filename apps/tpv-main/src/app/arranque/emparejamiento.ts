// src/app/arranque/emparejamiento.ts
//
// Cómo se vincula un Handy a su Main, sin React: leer el código que se escribe o se escanea, el
// bucle que reclama el emparejamiento, espera a que la Main lo apruebe y guarda el token, y la
// cancelación de esa espera.
//
// El bucle recibe sus dependencias (el IPC, la nube, si la espera sigue en pie) en vez de
// importarlas, igual que `recoverySync.ts`: así se prueba con dobles y un reloj falso
// (`test/emparejamientoHandy.test.ts`), y la pantalla sólo lo arranca y pinta lo que devuelve.

import { esError } from "@tpv/client";

import { horaParaFirmar } from "../../shared/lib/horaParaFirmar";

/** Cada cuánto se pregunta si la Main ya ha aprobado. */
export const ESPERA_ENTRE_CONSULTAS_MS = 1500;
/**
 * Cuánto se espera si la nube no dice cuánto le queda al código. Un worker actual siempre lo dice
 * (`caducaEnMs`); esto cubre uno anterior, cuyo reto caducaba a los dos minutos.
 */
export const ESPERA_SI_LA_NUBE_NO_LO_DICE_MS = 2 * 60 * 1000;

// Los fallos que genera el propio emparejamiento. Acaban tal cual en la pantalla de vinculación,
// delante de quien está vinculando el Handy, así que dicen qué hacer y no llevan códigos internos:
// antes salía, por ejemplo, `pair_timeout_waiting_approval` cuando la Main no aprobaba a tiempo.
const SIN_IDENTIDAD =
	"Este dispositivo todavía no tiene su identidad preparada. Cierra la aplicación, vuelve a abrirla e inténtalo de nuevo.";
const RESPUESTA_INESPERADA =
	"La nube ha respondido algo inesperado al vincular. Inténtalo de nuevo y, si se repite, genera un código nuevo en el TPV principal.";
const SIN_APROBACION =
	"El código ha caducado sin que el TPV principal aprobara la vinculación. Genera un código nuevo en el TPV principal y vuelve a intentarlo.";

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

/** Lo que queda pendiente mientras se espera la aprobación: con esto se puede cancelar. */
export type EsperaDeAprobacion = CodigoDeVinculacion & { nonceB64: string; nonceExpiresAtMs: number };

/** El IPC con Rust (`invokeClient`). */
export type Invocar = <T>(comando: string, args?: Record<string, unknown>) => Promise<T>;

/** Una petición anónima al worker (`cloudPost("anon", …)`). */
export type PedirALaNube = <T>(ruta: string, cuerpo: unknown) => Promise<T>;

export type DependenciasEmparejamiento = {
	invoke: Invocar;
	pedirALaNube: PedirALaNube;
	/** `false` en cuanto la espera deja de interesar (pantalla cerrada, o cancelada): el bucle para. */
	sigueVivo: () => boolean;
	/** Se llama al reclamar, cuando empieza la espera de la aprobación. */
	alQuedarPendiente: (pendiente: EsperaDeAprobacion) => void;
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

/**
 * La prueba de que habla el dispositivo que reclamó. La acción va dentro de lo firmado para que la
 * firma de una consulta no sirva para cancelar, ni al revés (`pairing.firma.ts` en el worker).
 */
async function firmar(
	invoke: Invocar,
	accion: "PAIR_FETCH" | "PAIR_CANCEL",
	pairCode: string,
	nonceB64: string,
	deviceId: string,
): Promise<{ ts: number; sigB64: string }> {
	// PROD-04: la hora de la nube, que Rust ya tiene de la respuesta al `claim`. Con la del equipo,
	// una Handy con el reloj desfasado más de 2 minutos no conseguiría vincularse nunca.
	const ts = await horaParaFirmar(invoke);
	const payload = `${ts}\n${accion}\n${pairCode}\n${nonceB64}\n${deviceId}`;
	const r = (await invoke("device_sign_b64", { args: { payload } })) as any;
	const sigB64 = String(r.sigB64 ?? r.sig_b64 ?? r.signature ?? "").trim();
	if (!sigB64) throw new Error(SIN_IDENTIDAD);
	return { ts, sigB64 };
}

/**
 * Reclama el emparejamiento con la Main y espera a que lo apruebe.
 *
 * Devuelve el emparejamiento ya guardado (el token queda en el keyring vía `handy_set_token`), o
 * `null` si la espera dejó de interesar. «Todavía sin aprobar» no es un fallo: se sigue
 * preguntando hasta que caduca el código. Cualquier otro error corta en el acto, también que la
 * Main lo rechace; los de la nube llegan tal como los da el IPC.
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

	// Hasta cuándo se espera lo dice la nube, en relativo: se suma a ESTE reloj, que no tiene por
	// qué coincidir con el del worker. Antes era una constante de 3 minutos que no casaba con el
	// reto del servidor.
	const caducaEnMs = Number(claim.caducaEnMs);
	const limite =
		Date.now() + (Number.isFinite(caducaEnMs) && caducaEnMs > 0 ? caducaEnMs : ESPERA_SI_LA_NUBE_NO_LO_DICE_MS);

	deps.alQuedarPendiente({ pairCode, pairSecret, nonceB64, nonceExpiresAtMs });

	while (Date.now() < limite) {
		await new Promise((r) => setTimeout(r, ESPERA_ENTRE_CONSULTAS_MS));
		if (!deps.sigueVivo()) return null;

		const { ts, sigB64 } = await firmar(deps.invoke, "PAIR_FETCH", pairCode, nonceB64, ident.deviceId);

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

			// Si se canceló mientras volvía la respuesta, no se guarda: quien canceló espera ver la
			// pantalla de vinculación, no un Handy vinculado a sus espaldas.
			if (!deps.sigueVivo()) return null;

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

/**
 * Suelta en la nube el código que se estaba esperando, para que desaparezca de la lista de la Main
 * y nadie apruebe una solicitud que ya no espera nadie. Es lo que hace el botón «Cancelar».
 *
 * Quien llama decide qué hacer si falla: la pantalla ya ha dejado de esperar, y lo peor que pasa
 * es que la solicitud siga en la lista hasta que caduque el código.
 */
export async function cancelarEmparejamiento(
	espera: EsperaDeAprobacion,
	deps: Pick<DependenciasEmparejamiento, "invoke" | "pedirALaNube">,
): Promise<void> {
	const ident = await identidadDelDispositivo(deps.invoke);
	const { ts, sigB64 } = await firmar(deps.invoke, "PAIR_CANCEL", espera.pairCode, espera.nonceB64, ident.deviceId);

	await deps.pedirALaNube("/v1/pair/cancel", {
		pairCode: espera.pairCode,
		deviceId: ident.deviceId,
		nonceB64: espera.nonceB64,
		ts,
		sigB64,
	});
}
