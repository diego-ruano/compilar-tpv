// src/shared/stores/useSyncSignal.ts
//
// Señal de "han cambiado datos por sincronización con la nube". La usa el POS (mesas y
// venta_rápida), que NO está en React Query y por tanto no se puede invalidar: estos
// componentes observan `tick` y, al cambiar, vuelven a leer su estado de la BD local.
//
// Además del contador `tick` (que dispara la relectura del catálogo / barra de comandas),
// transporta `comanda`: qué comandas tocó el último lote sincronizado, para que el POS
// recargue el TICKET solo si la comanda afectada es la que está abierta (no la de otro
// dispositivo). Ver `shared/lib/syncStatements.ts`.
//
// La dispara `useMainSocket` / `useHandySocket` tras aplicar un lote recibido por WebSocket.

import { create } from "zustand";

import type { ComandaSyncInfo } from "../lib/syncStatements";

const EMPTY_COMANDA: ComandaSyncInfo = {
	ids: [],
	touchedComanda: false,
	uncertain: false,
	touchedCatalog: false,
};

// Por defecto (si quien bumpea no aporta info) asumimos lo seguro: recargar todo.
const UNCERTAIN_COMANDA: ComandaSyncInfo = {
	ids: [],
	touchedComanda: true,
	uncertain: true,
	touchedCatalog: true,
};

type SyncSignalStore = {
	tick: number;
	/** Comandas afectadas por el último lote (snapshot del bump más reciente). */
	comanda: ComandaSyncInfo;
	bump: (comanda?: ComandaSyncInfo) => void;
};

export const useSyncSignal = create<SyncSignalStore>((set) => ({
	tick: 0,
	comanda: EMPTY_COMANDA,
	bump: (comanda) =>
		set((s) => ({
			tick: s.tick + 1,
			comanda: comanda ?? UNCERTAIN_COMANDA,
		})),
}));
