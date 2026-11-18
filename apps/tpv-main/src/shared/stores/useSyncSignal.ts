// src/shared/stores/useSyncSignal.ts
//
// Señal de "han cambiado datos por sincronización con la nube". La usa lo que NO está en React
// Query y por tanto no se puede invalidar (el POS: mesas, venta rápida y la cocina; el login):
// estos componentes observan `tick` y, al cambiar, vuelven a leer su estado de la BD local.
//
// Además del contador `tick` (que dispara la relectura del catálogo / barra de comandas),
// transporta `comanda`: qué comandas tocó el último lote sincronizado, para que el POS
// recargue el TICKET solo si la comanda afectada es la que está abierta (no la de otro
// dispositivo). Ver `shared/lib/syncStatements.ts`.
//
// Y `tablas`: qué tablas tocó (TRA-INC-04). El login no tiene una comanda que mirar: relee los
// usuarios cuando cambian `usuarios`, `trabajadores` o `roles`, y el fichaje del seleccionado
// cuando cambian `fichajes` o `fichaje_dia`. `null` es «no se sabe» y cuenta como todas.
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
	/** Tablas que tocó el último lote; `null` si no se sabe (una conexión nueva, sin clasificar). */
	tablas: string[] | null;
	bump: (comanda?: ComandaSyncInfo, tablas?: string[] | null) => void;
};

export const useSyncSignal = create<SyncSignalStore>((set) => ({
	tick: 0,
	comanda: EMPTY_COMANDA,
	tablas: [],
	bump: (comanda, tablas) =>
		set((s) => ({
			tick: s.tick + 1,
			comanda: comanda ?? UNCERTAIN_COMANDA,
			tablas: tablas === undefined ? null : tablas,
		})),
}));

/** ¿Ha tocado el lote alguna de `buscadas`? Sin saber cuáles tocó (`null`), sí. */
export function tocaAlgunaTabla(tablas: string[] | null, buscadas: readonly string[]): boolean {
	if (tablas === null) return true;
	const tocadas = new Set(tablas.map((t) => t.toLowerCase()));
	return buscadas.some((t) => tocadas.has(t));
}
