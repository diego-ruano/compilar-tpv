// src/shared/stores/useConnectionMode.ts
//
// Modo de funcionamiento de la Main respecto a la nube (ajuste explícito, NO autodetectado):
//
//   - "offline": solo SQLite local. No se abre WebSocket ni se habla con la nube. Máxima
//     robustez y velocidad. Es el comportamiento por defecto.
//   - "online":  además de trabajar en local, la Main mantiene un WebSocket con el worker para
//     espejar los cambios a la nube (copia de seguridad) y permitir dispositivos Handy.
//
// La Main SIEMPRE es Local-First: este modo solo decide si, ADEMÁS, se sincroniza con la nube.
// El cliente WebSocket (fase posterior) leerá este valor para decidir si conectarse.

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ConnectionMode = "offline" | "online";

type ConnectionModeStore = {
	mode: ConnectionMode;
	setMode: (mode: ConnectionMode) => void;
};

export const useConnectionMode = create<ConnectionModeStore>()(
	persist(
		(set) => ({
			mode: "offline",
			setMode: (mode) => set({ mode }),
		}),
		{ name: "connection-mode" }, // key de localStorage
	),
);
