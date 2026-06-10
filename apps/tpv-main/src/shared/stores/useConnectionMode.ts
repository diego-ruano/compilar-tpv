// src/shared/stores/useConnectionMode.ts
//
// Modo de funcionamiento de la Main respecto a la nube (ajuste explícito, NO autodetectado):
//
//   - "offline": solo SQLite local. No se abre WebSocket ni se habla con la nube.
//   - "online":  además, la Main mantiene un WebSocket con el worker (copia de seguridad +
//     dispositivos Handy).
//
// La fuente de verdad es `device_config.json` en AppData (comandos Tauri get/set_connection_mode);
// no usamos localStorage para que el backend pueda leer el mismo valor. La Main SIEMPRE es
// Local-First: este modo solo decide si, ADEMÁS, se sincroniza con la nube.

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export type ConnectionMode = "offline" | "online";

type ConnectionModeStore = {
	mode: ConnectionMode;
	hydrated: boolean;
	/** Carga el modo persistido desde AppData (llamar una vez al arrancar). */
	hydrate: () => Promise<void>;
	/** Cambia el modo y lo persiste en AppData. */
	setMode: (mode: ConnectionMode) => Promise<void>;
};

export const useConnectionMode = create<ConnectionModeStore>((set) => ({
	mode: "offline",
	hydrated: false,
	hydrate: async () => {
		try {
			const m = await invoke<ConnectionMode | null>("get_connection_mode");
			set({ mode: m === "online" ? "online" : "offline", hydrated: true });
		} catch {
			set({ hydrated: true });
		}
	},
	setMode: async (mode) => {
		set({ mode });
		try {
			await invoke("set_connection_mode", { args: { mode } });
		} catch (e) {
			console.warn("set_connection_mode falló:", e);
		}
	},
}));
