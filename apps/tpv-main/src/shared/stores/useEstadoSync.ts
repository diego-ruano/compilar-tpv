// src/shared/stores/useEstadoSync.ts
//
// SYNC-17: estado de la sincronización con la nube. **Derivado, no elegido.**
//
// Antes esto era `useConnectionMode`: un ajuste "offline/online" que el usuario tenía que
// seleccionar en Configuración para que la Main abriese el WebSocket. Era una pregunta que el
// usuario no puede responder bien (¿hay conexión ahora mismo?) y cuya respuesta se quedaba vieja:
// marcado "online" sin red, el TPV mentía; marcado "offline" con red, no sincronizaba y nadie lo
// sabía. Ahora la Main **lo intenta siempre** y aquí se publica lo que realmente está pasando.
//
// Dos cosas distintas conviven en este store, y conviene no confundirlas:
//
//   · `estado`      → lo que ESTÁ pasando (lo escribe `useMainSocket` en cada transición).
//   · `preferencia` → la palanca de emergencia (`auto` | `off`), persistida en
//                     `device_config.json`. NO tiene UI: se toca a mano o con el comando
//                     `set_connection_mode`. Por defecto `auto`.

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

/**
 * Estado real de la conexión con la nube.
 *
 * - `pausada`: no se intenta nada, y se ve como tal. Dos motivos posibles: la palanca en `off`, o
 *   una BD local vacía a la espera de recuperarse (ver `datosPerdidos`).
 * - `sin_identidad`: todavía no hay licencia activada o identidad de dispositivo, así que no hay
 *   a dónde conectarse. No es un fallo: es un TPV recién instalado.
 * - `conectando`: pidiendo ticket / abriendo el socket.
 * - `conectado`: autenticado en el TenantHub. Es el único estado en el que las Handy pueden
 *   operar y el outbox se drena.
 * - `reintentando`: se cayó o no se pudo abrir; hay un reintento programado con backoff.
 * - `rechazado`: el worker dice que no (licencia caducada/anulada, dispositivo desplazado).
 *   Reintentar cada pocos segundos no lo arregla, así que se espacia mucho.
 */
export type EstadoSync =
	| "pausada"
	| "sin_identidad"
	| "conectando"
	| "conectado"
	| "reintentando"
	| "rechazado";

/** Palanca de emergencia persistida (sin UI). `auto` = intentar siempre. */
export type PreferenciaSync = "auto" | "off";

type EstadoSyncStore = {
	preferencia: PreferenciaSync;
	hidratada: boolean;
	/**
	 * La BD local está vacía y pendiente de recuperarse desde la nube. Mientras esté puesto, la
	 * Main NO abre el socket.
	 *
	 * No es una preferencia ni un estado de la red: es que sincronizar contra una BD vacía sería
	 * activamente dañino. El catch-up arrancaría en `Last_Seq = 0` y reproduciría días de
	 * operaciones (UPDATEs, borrados, líneas de comanda) sobre tablas sin las filas a las que se
	 * refieren; cada una fallaría cinco veces y acabaría en cuarentena, dejando el panel de salud
	 * lleno de errores que no explican nada. Y no reconstruiría la BD igualmente: `Sync_Changes`
	 * sólo guarda 7 días. Lo que reconstruye es el bootstrap, y hasta entonces esto espera.
	 */
	datosPerdidos: boolean;
	estado: EstadoSync;
	/** Texto diagnóstico del último cambio (motivo del rechazo, error de red…). Nunca se compara. */
	detalle: string | null;
	/** `Date.now()` del último cambio REAL de estado: permite decir "sin conexión desde las 12:41". */
	desde: number;
	/** Contador que `useMainSocket` observa para reintentar ya (sin esperar al backoff). */
	pulso: number;

	/** Carga la palanca desde AppData. Llamar una vez al arrancar. */
	hidratar: () => Promise<void>;
	/** Publica el estado actual. Repetir el mismo estado no reinicia `desde`. */
	marcar: (estado: EstadoSync, detalle?: string | null) => void;
	/** Pide un intento de conexión inmediato (p. ej. al activar la licencia). */
	reintentar: () => void;
	/** Marca/desmarca que la BD local está a la espera de recuperarse (ver `datosPerdidos`). */
	marcarDatosPerdidos: (perdidos: boolean) => void;
};

export const useEstadoSync = create<EstadoSyncStore>((set, get) => ({
	preferencia: "auto",
	hidratada: false,
	datosPerdidos: false,
	estado: "conectando",
	detalle: null,
	desde: Date.now(),
	pulso: 0,

	hidratar: async () => {
		try {
			const p = await invoke<PreferenciaSync | null>("get_connection_mode");
			// Cualquier cosa que no sea explícitamente `off` es `auto`: el valor ausente (nunca se
			// tocó) y el legado ("offline"/"online", que Rust ya normaliza a `null`) conectan.
			set({ preferencia: p === "off" ? "off" : "auto", hidratada: true });
		} catch {
			set({ hidratada: true });
		}
	},

	marcar: (estado, detalle = null) => {
		const prev = get();
		if (prev.estado === estado && prev.detalle === detalle) return;
		// `desde` solo se mueve si cambia el estado: si seguimos "reintentando" y solo cambia el
		// texto del error, el usuario quiere saber desde cuándo estamos así, no desde el último
		// intento fallido.
		set({
			estado,
			detalle,
			desde: prev.estado === estado ? prev.desde : Date.now(),
		});
	},

	reintentar: () => set((s) => ({ pulso: s.pulso + 1 })),

	marcarDatosPerdidos: (perdidos) => {
		if (get().datosPerdidos === perdidos) return;
		set({ datosPerdidos: perdidos });
		// Al recuperarse hay que conectar ya: la BD acaba de quedar al día y el catch-up debe
		// seguir desde el checkpoint que dejó el bootstrap, no dentro de un backoff.
		if (!perdidos) set((s) => ({ pulso: s.pulso + 1 }));
	},
}));
