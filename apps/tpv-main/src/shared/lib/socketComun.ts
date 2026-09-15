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

/** Firma el saludo del socket con la clave del dispositivo, para contestar al `challenge` del hub. */
export async function firmarHello(
	ts: number,
	tenantId: string,
	deviceId: string,
	nonceB64: string,
): Promise<string> {
	const payload = `${ts}\nWS_HELLO\n${tenantId}\n${deviceId}\n${nonceB64}`;
	const r = (await invoke<any>("device_sign_b64", { args: { payload } })) as any;
	return String(r?.sigB64 ?? r?.sig_b64 ?? "");
}
