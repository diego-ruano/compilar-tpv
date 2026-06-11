// src/shared/stores/useSyncSignal.ts
//
// Señal de "han cambiado datos por sincronización con la nube". La usa el POS (mesas y
// venta_rápida), que NO está en React Query y por tanto no se puede invalidar: estos
// componentes observan `tick` y, al cambiar, vuelven a leer su estado de la BD local.
//
// La dispara `useMainSocket` tras aplicar un lote recibido por WebSocket (o por el catch-up).
// Es un simple contador monotono; no transporta datos, solo "vuelve a leer".

import { create } from "zustand";

type SyncSignalStore = {
	tick: number;
	bump: () => void;
};

export const useSyncSignal = create<SyncSignalStore>((set) => ({
	tick: 0,
	bump: () => set((s) => ({ tick: s.tick + 1 })),
}));
