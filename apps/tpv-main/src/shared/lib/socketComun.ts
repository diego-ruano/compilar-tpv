// src/shared/lib/socketComun.ts
//
// Lo que comparten el socket de la Main (`socketMain.ts`) y el de la Handy (`socketHandy.ts`): cuánto
// se espera entre reintentos, cómo se sabe que un socket sigue vivo y cómo se identifica el equipo al
// abrirlo.
//
// Los dos sockets hacen cosas distintas —la Main aplica cambios y sube su outbox; la Handy sólo
// escucha y vigila si hay una Main—, así que no comparten su máquina de estados, que sería forzar una
// abstracción. Comparten estas piezas, que son las que, copiadas en cada uno, se separaban: el vigía
// del latido de SYNC-17 se añadió a la Main y la Handy se quedó sin él.

import { invoke } from "@tauri-apps/api/core";
import { toAppError } from "@tpv/client";

import { cloudPost } from "./cloudApi";

// SYNC-09: backoff exponencial con tope + jitter. Empieza en 3 s y sube hasta 30 s ante cortes
// prolongados (worker caído/sin red), en vez de martillear cada 3 s. Se reinicia al autenticarse.
export const RECONEXION_BASE_MS = 3000;
export const RECONEXION_MAX_MS = 30000;
export const LATIDO_MS = 30000;
// SYNC-17: margen sin `pong` antes de dar el socket por muerto. Un TCP medio-abierto (la ruta se
// cae sin FIN: cambio de red, NAT que expira, suspensión del equipo) NO dispara `onclose`, así que
// sin este vigía el socket se queda abierto sin recibir nada y nadie se entera. Dos latidos de
// margen: un `pong` perdido suelto no cierra nada.
export const SIN_PONG_MS = LATIDO_MS * 2 + 5000;
// SYNC-17: la espera cuando el worker dice que NO. Insistir cada pocos segundos es pedirle lo
// mismo una y otra vez; lo que cambia la respuesta es renovar la licencia o volver a vincular el
// equipo, y eso llega por otro camino (el `pulso` de la Main, el botón de la Handy).
export const RETRY_RECHAZADO_MS = 5 * 60_000;

/** Las esperas entre reintentos: crecen al doble hasta el tope y vuelven a la base al reiniciar. */
export function crearEsperas() {
	let retardo = RECONEXION_BASE_MS;
	return {
		/** La espera del próximo intento, con hasta 1 s de azar para que no reintenten todos a la vez. */
		siguiente(): number {
			const espera = Math.min(retardo, RECONEXION_MAX_MS) + Math.random() * 1000;
			retardo = Math.min(retardo * 2, RECONEXION_MAX_MS);
			return espera;
		},
		/** La conexión ha llegado a estar sana: el próximo corte vuelve a empezar por la espera corta. */
		reiniciar(): void {
			retardo = RECONEXION_BASE_MS;
		},
	};
}

/**
 * SYNC-17: el latido de un socket y el vigía que lo da por muerto.
 *
 * Cada `LATIDO_MS` manda un `ping`, pero antes comprueba que el anterior tuvo respuesta: si lleva más
 * de `SIN_PONG_MS` sin un `pong`, cierra. Sin esa comprobación se mandaban `ping` a un socket muerto
 * para siempre, porque nadie leía el `pong`. Cerrar dispara `onclose`, y de ahí sale la reconexión.
 *
 * El `pong` lo contesta el auto-response del edge sin despertar al Durable Object (`tenantHub.ts`),
 * así que llega aunque el hub esté hibernando: es justo lo que lo convierte en una señal fiable de que
 * la ruta hasta la nube sigue viva. El reloj cuenta desde que se llama, que es al abrir el socket: si
 * el primer `pong` no llega, también cierra.
 */
export function vigilarLatido(socket: WebSocket) {
	let ultimoPong = Date.now();
	const temporizador = setInterval(() => {
		if (socket.readyState !== WebSocket.OPEN) return;
		if (Date.now() - ultimoPong > SIN_PONG_MS) {
			console.warn("[ws] sin pong en", SIN_PONG_MS, "ms: socket muerto, cerrando");
			try {
				socket.close();
			} catch {
				/* noop */
			}
			return;
		}
		socket.send(JSON.stringify({ type: "ping" }));
	}, LATIDO_MS);

	return {
		/** Llamarlo al recibir un `pong`. */
		pong(): void {
			ultimoPong = Date.now();
		},
		parar(): void {
			clearInterval(temporizador);
		},
	};
}

export async function leerIdDispositivo(): Promise<string> {
	try {
		const r = (await invoke<any>("device_get_identity")) as any;
		return String(r?.deviceId ?? r?.device_id ?? "");
	} catch {
		return "";
	}
}

/**
 * Firma el saludo del socket con la clave del dispositivo, para contestar al `challenge` del hub.
 *
 * La hora la pone esta función y no quien llama (PROD-04): tiene que ser la de la nube, porque el hub
 * rechaza un saludo con más de 2 minutos de desfase (`ts_out_of_range`). La trae la respuesta del
 * ticket, que siempre llega antes que el `challenge`.
 */
export async function firmarHello(
	_tenantId: string,
	_deviceId: string,
	nonceB64: string,
): Promise<{ ts: number; sigB64: string }> {
	const r = await invoke<{ ts: number; sigB64: string }>("device_firmar_hello", { args: { nonce_b64: nonceB64 } });
	return r;
}

/** Resultado de pedir el ticket: hay que distinguir "no hay red" de "el worker dice que no". */
export type ResultadoTicket =
	| { ok: true; ticket: string }
	| { ok: false; rechazado: boolean; codigo: string; detalle: string };

/**
 * Códigos con los que el worker nos está diciendo que este dispositivo no puede sincronizar.
 *
 * Reintentar en 3 s no cambia ninguno: una licencia caducada se renueva, y un dispositivo revocado
 * (o cuya fila ya no está en este negocio, que llega como el mismo código) se vuelve a vincular.
 * Lo que NO puede pasar es confundirlos con un corte de red, porque entonces la pantalla dice
 * «Conectando…» para siempre y nadie llega a enterarse de lo que pasa de verdad.
 */
export const CODIGOS_RECHAZO = new Set(["license_expired", "license_not_found", "device_revoked"]);

/**
 * SYNC-15: canjea el token por un ticket efímero de un solo uso para NO exponer el JWT en la URL
 * del WebSocket. Si falla NO se abre el WS (ya no existe respaldo `?token=`: el token nunca viaja
 * por la URL) y quien llama decide cuánto esperar según el motivo.
 *
 * Lo usan la Main y la Handy: es el mismo intercambio y, sobre todo, la misma lectura del fallo.
 * Estaba sólo en la Main (REV-02), y la Handy se tragó todos los errores por igual hasta que su
 * token de 30 días caducó y se quedó reintentando contra una pared.
 */
export async function pedirTicketWs(mode: "tpv" | "handy"): Promise<ResultadoTicket> {
	try {
		const r = (await cloudPost<any>(mode, "/v1/ws/ticket", {})) as any;
		const t = String(r?.ticket ?? "");
		if (!t) return { ok: false, rechazado: false, codigo: "", detalle: "respuesta sin ticket" };
		return { ok: true, ticket: t };
	} catch (e) {
		const err = toAppError(e);
		return {
			ok: false,
			rechazado: CODIGOS_RECHAZO.has(err.code),
			codigo: err.code,
			detalle: err.message || err.code,
		};
	}
}
