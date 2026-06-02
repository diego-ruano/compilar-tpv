import { create } from "zustand";

export type NetStatus = "online" | "offline";

type NetState = {
	status: NetStatus;
	consecutiveFails: number;
	lastOkAt: number | null;

	/**
	 * Marca conexión OK real.
	 */
	setOnline: () => void;

	/**
	 * Fallo suave, pensado para healthcheck.
	 * No pasa a offline hasta varios fallos seguidos.
	 */
	reportHealthFail: () => void;

	/**
	 * Fallo real de una llamada importante de API.
	 * Pasa a offline inmediatamente.
	 */
	forceOffline: () => void;

	/**
	 * Alias temporal para compatibilidad con código antiguo.
	 * Usa reportHealthFail en código nuevo.
	 */
	setOffline: () => void;
};

export const useNet = create<NetState>((set, get) => ({
	status: "offline",
	consecutiveFails: 0,
	lastOkAt: null,

	setOnline: () =>
		set({
			status: "online",
			consecutiveFails: 0,
			lastOkAt: Date.now(),
		}),

	reportHealthFail: () => {
		const fails = get().consecutiveFails + 1;

		set({
			consecutiveFails: fails,
			status: fails >= 2 ? "offline" : get().status,
		});
	},

	forceOffline: () =>
		set((state) => ({
			status: "offline",
			consecutiveFails: Math.max(2, state.consecutiveFails + 1),
		})),

	setOffline: () => {
		get().reportHealthFail();
	},
}));