import { commands } from "@tpv/client";
// src/app/arranque/useModoDispositivo.ts
//
// El modo del dispositivo (TPV principal o Handy): leerlo al arrancar, elegirlo en el primer inicio y
// volver al selector.

import { useEffect, useRef, useState } from "react";
import { toAppError } from "@tpv/client";
import type { DeviceMode } from "@tpv/contracts";

import { queryClient } from "../../shared/lib/queryClient";
import { limpiarCacheImagenes } from "../../shared/lib/imageUrl";
import { useAuth } from "../../shared/stores/useAuth";
import { useMode, type ModeStateValue } from "../../shared/stores/useMode";

function isDeviceMode(value: unknown): value is DeviceMode | null {
	return value === "tpv" || value === "handy" || value === null;
}

/** `alElegir` se llama después de fijar el modo (la Main vuelve a leer su licencia). */
export function useModoDispositivo(opciones: { alElegir: () => Promise<void> }) {
	const modo = useMode((s) => s.mode);
	const setMode = useMode((s) => s.setMode);
	const [ocupado, setOcupado] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Al cambiar de modo (tpv ↔ handy) las URLs de imagen cambian (AppData vs el worker).
	// Limpiamos el caché de React Query para que los datos se refresquen con el modo nuevo.
	const modoAnteriorRef = useRef<ModeStateValue>("loading");
	useEffect(() => {
		const anterior = modoAnteriorRef.current;
		modoAnteriorRef.current = modo;
		if (modo !== "loading" && anterior !== "loading" && anterior !== modo) {
			queryClient.clear();
			limpiarCacheImagenes();
		}
	}, [modo]);

	useEffect(() => {
		void (async () => {
			try {
				const rawMode = await commands.getDeviceMode();
				setMode(isDeviceMode(rawMode) ? rawMode : null);
			} catch (e: any) {
				setError(toAppError(e).message);
				setMode(null);
			}
		})();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	async function elegir(m: DeviceMode) {
		setOcupado(true);
		setError(null);

		try {
			await commands.setDeviceMode({ mode: m });

			if (m === "tpv") {
				await commands.initMain();
			}

			setMode(m);

			await opciones.alElegir();
		} catch (e: any) {
			setError(toAppError(e).message);
		} finally {
			setOcupado(false);
		}
	}

	/**
	 * AUD-23: el selector de modo sin tocar nada guardado, ni el modo del backend ni el vínculo de la
	 * Handy. Lo decide lo que se elija después: «Handy» vuelve al vínculo guardado, «TPV» sigue el
	 * camino de la activación y un código de otra Main lo sustituye. Desvincular es de
	 * Configuración → Dispositivo, con administrador. La sesión se cierra: quien sale al selector
	 * deja de trabajar, y elegir un modo la cerraría igual en Rust.
	 */
	function irAlSelector() {
		setError(null);
		useAuth.getState().logout();
		setMode(null);
	}

	async function volverAlSelector() {
		setOcupado(true);
		setError(null);

		try {
			// Reversibilidad real: persiste mode=None, suelta los backends y, si veníamos de
			// Handy, desvincula el token. Tras esto, al reiniciar la app vuelve a salir el
			// selector de modo (no solo es un cambio visual).
			await commands.deviceResetMode();
			setMode(null);
		} catch (e: any) {
			setError(toAppError(e).message);
		} finally {
			setOcupado(false);
		}
	}

	/** Quita el error de la vista: la pantalla que lo enseña empieza de cero («Limpiar»). */
	function olvidarError() {
		setError(null);
	}

	return { ocupado, error, elegir, irAlSelector, volverAlSelector, olvidarError };
}
