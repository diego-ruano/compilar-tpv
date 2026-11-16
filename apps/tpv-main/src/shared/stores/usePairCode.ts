import { commands } from "@tpv/client";
// src/shared/stores/usePairCode.ts
//
// Código de emparejamiento vigente de esta Main (el que pinta el QR de Configuración →
// Vincular Handy).
//
// Vive en un store y no en el estado del componente porque el código **es del dispositivo, no
// de la pantalla**: lo emite el worker con una caducidad de minutos, y salir de Configuración y
// volver no debería invalidarlo. Antes el estado colgaba de la página, que se desmonta al
// navegar, así que cada visita pedía uno nuevo: el QR cambiaba delante del camarero que estaba
// intentando escanearlo, y el TPV gastaba una petición firmada por visita.
//
// La regla es: se pide uno nuevo sólo si no hay ninguno, si el que hay ya caducó, si alguien
// pulsa "Regenerar", o si ya se ha gastado (OBS-01): un código es de un solo uso, y en cuanto una
// Handy lo reclama ya no le sirve a otra aunque le quede tiempo.

import { create } from "zustand";

import { toAppError } from "@tpv/client";
import type { PairCreateResult } from "@tpv/contracts";

type PairCodeStore = {
	code: string;
	secret: string;
	expiresAtMs: number | null;

	loading: boolean;
	error: string | null;

	/** Pide un código sólo si hace falta (no hay, o el que hay ya caducó). */
	asegurar: () => Promise<void>;
	/** Pide uno nuevo aunque el actual siga vigente (botón "Regenerar"). */
	regenerar: () => Promise<void>;
	/** `code` ya lo ha reclamado una Handy: si es el que se enseña, se cambia por uno nuevo. */
	gastado: (code: string) => Promise<void>;
};

/**
 * Margen antes de dar por muerto un código. Uno al que le quedan tres segundos no le sirve a
 * nadie: no da tiempo ni a sacar el móvil, y el Handy recibiría un `expired` al reclamarlo.
 */
const MARGEN_MS = 10_000;

function caducado(expiresAtMs: number | null): boolean {
	if (!expiresAtMs) return true;
	return expiresAtMs - Date.now() <= MARGEN_MS;
}

export const usePairCode = create<PairCodeStore>((set, get) => {
	async function pedir(): Promise<void> {
		set({ loading: true, error: null });

		try {
			// Comando hexagonal dedicado: pide al worker un código nuevo (firma device-proof en
			// modo TPV) y devuelve el DTO tipado generado desde Rust.
			const j = await commands.pairCreate();

			set({
				code: String(j.pairCode || ""),
				secret: String(j.pairSecret || ""),
				expiresAtMs: typeof j.expiresAtMs === "number" ? j.expiresAtMs : null,
			});
		} catch (e) {
			set({ error: toAppError(e).message });
		} finally {
			set({ loading: false });
		}
	}

	return {
		code: "",
		secret: "",
		expiresAtMs: null,
		loading: false,
		error: null,

		asegurar: async () => {
			const s = get();
			// Sin este corte, dos montajes seguidos (o el efecto de caducidad disparando a la
			// vez que la entrada en la sección) pedirían dos códigos y el segundo dejaría al
			// primero huérfano en la nube.
			if (s.loading) return;
			if (s.code && !caducado(s.expiresAtMs)) return;

			await pedir();
		},

		regenerar: async () => {
			if (get().loading) return;
			await pedir();
		},

		gastado: async (code) => {
			const s = get();
			if (s.loading || !code || s.code !== code) return;
			await pedir();
		},
	};
});
