// src/shared/stores/useMainPresence.ts
//
// Presencia de la Main vista por un Handy. El Handy NO tiene datos propios: depende por completo
// de que haya una Main activa (conectada por WebSocket al worker). Si no la hay, el Handy debe
// quedar BLOQUEADO por completo (ni siquiera login), porque cualquier escritura sería rechazada
// por el worker (freeze `main_offline`) y operar a ciegas no tiene sentido.
//
// El worker ya informa de la presencia por WebSocket:
//   - `main_status` { online, volcando } → al autenticarse el Handy (estado inicial).
//   - `main_online`                      → cuando una Main se autentica.
//   - `main_offline`                     → cuando la última Main se desconecta.
//   - `main_volcando` { volcando }       → la Main está subiendo su atraso (SYNC-18).
// Rust interpreta esos mensajes y publica un estado atómico; `AppBoot` decide si deja pasar.
//
// Semántica de `mainOnline`:
//   - null  → desconocido (WS aún conectando / sin confirmar). Fail-closed: se bloquea.
//   - false → confirmado que NO hay Main. Se bloquea.
//   - true  → hay Main activa. Se deja operar.
//
// Y aparte del bloqueo está el RECHAZO, que es otra cosa: no es que no haya Main, es que la nube no
// deja entrar a ESTE Handy (le han revocado el acceso, o la licencia del negocio no está activa).
// Sin distinguirlo, los dos casos se veían igual —«Conectando con la Main…», girando— y el único
// que se arregla solo es el primero.

import { create } from "zustand";
import type { ConexionHandy } from "@tpv/contracts";

/**
 * Por qué la nube no deja entrar a este Handy. Son dos porque lo que hay que hacer es distinto:
 * `licencia` se arregla en la Main (renovarla) y este Handy se desbloquea solo; `dispositivo` se
 * arregla aquí, volviendo a vincularlo.
 */
export type MotivoRechazo = "dispositivo" | "licencia";

type MainPresenceStore = {
	generacion: number;
	conexion: number;
	tenantId: string | null;
	estadoConexion: ConexionHandy;
	mainOnline: boolean | null;
	/**
	 * La nube ha rechazado a este Handy (`null` = no ha pasado). Rust clasifica el rechazo;
	 * el puente publica ese estado y lo retira cuando vuelve a confirmarse la conexión.
	 */
	rechazo: MotivoRechazo | null;
	/**
	 * SYNC-18: la Main está conectada pero subiendo el atraso que acumuló sin conexión, así que la
	 * nube todavía no refleja su estado. El Handy se bloquea igual que sin Main —escribir sobre un
	 * estado a medio construir es pedir un choque— pero lo que se le cuenta al camarero es otra
	 * cosa: esto se pasa solo en cuanto termine.
	 */
	volcando: boolean;
	// Señal del botón Reintentar: el puente pide una reconexión a Rust sin recrear observadores.
	retryTick: number;
	requestReconnect: () => void;
};

export const useMainPresence = create<MainPresenceStore>((set) => ({
	generacion: -1,
	conexion: -1,
	tenantId: null,
	estadoConexion: "pausada",
	mainOnline: null,
	rechazo: null,
	volcando: false,
	retryTick: 0,
	requestReconnect: () => set((s) => ({ retryTick: s.retryTick + 1 })),
}));
