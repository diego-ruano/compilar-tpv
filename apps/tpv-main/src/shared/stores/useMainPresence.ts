// src/shared/stores/useMainPresence.ts
//
// Presencia de la Main vista por un Handy. El Handy NO tiene datos propios: depende por completo
// de que haya una Main activa (conectada por WebSocket al worker). Si no la hay, el Handy debe
// quedar BLOQUEADO por completo (ni siquiera login), porque cualquier escritura sería rechazada
// por el worker (freeze `main_offline`) y operar a ciegas no tiene sentido.
//
// El worker ya informa de la presencia por WebSocket:
//   - `main_status` { online }  → al autenticarse el Handy (estado inicial).
//   - `main_online`             → cuando una Main se autentica.
//   - `main_offline`            → cuando la última Main se desconecta.
// `useHandySocket` traduce esos mensajes a este store, y `AppBoot` decide si deja pasar.
//
// Semántica de `mainOnline`:
//   - null  → desconocido (WS aún conectando / sin confirmar). Fail-closed: se bloquea.
//   - false → confirmado que NO hay Main. Se bloquea.
//   - true  → hay Main activa. Se deja operar.

import { create } from "zustand";

type MainPresenceStore = {
	mainOnline: boolean | null;
	setMainOnline: (v: boolean | null) => void;
	// Nonce para forzar una reconexión manual del WS del Handy (botón "Reintentar" en la pantalla de
	// espera). `useHandySocket` lo incluye en las deps de su efecto: al incrementarlo, el efecto se
	// re-ejecuta = conexión WS fresca (el equivalente a recargar la página en escritorio).
	retryTick: number;
	requestReconnect: () => void;
};

export const useMainPresence = create<MainPresenceStore>((set) => ({
	mainOnline: null,
	setMainOnline: (v) => set({ mainOnline: v }),
	retryTick: 0,
	requestReconnect: () => set((s) => ({ retryTick: s.retryTick + 1 })),
}));
