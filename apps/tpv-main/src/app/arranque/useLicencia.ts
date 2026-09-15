// src/app/arranque/useLicencia.ts
//
// El estado de la licencia de la Main durante el arranque: lo que hay guardado en el equipo, el último
// veredicto del gate y el aviso que llega cuando cambia.
//
// El pulso periódico de la licencia lo lleva el job `licencia` en Rust (jobs/registro.rs), no un
// temporizador de React: así sobrevive a una recarga del webview y sigue corriendo aunque el gate esté
// bloqueando la UI (una licencia renovada la desbloquea sola). Aquí sólo se escucha el resultado.

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invokeClient, toAppError } from "@tpv/client";
import type { LicenseGateResult, LicenseLocalState } from "@tpv/contracts";

import type { ModeStateValue } from "../../shared/stores/useMode";

export function useLicencia(modo: ModeStateValue) {
	const [lic, setLic] = useState<LicenseLocalState | null | "loading">("loading");
	const [gate, setGate] = useState<LicenseGateResult | "loading">("loading");
	const [errorAlBorrar, setErrorAlBorrar] = useState<string | null>(null);

	async function refrescarLicencia() {
		try {
			const st = await invokeClient<LicenseLocalState | null>("license_get_state");
			setLic(st);
		} catch {
			setLic(null);
		}
	}

	async function refrescarGate(forzar: boolean) {
		try {
			setGate("loading");

			const r = await invokeClient<LicenseGateResult>(forzar ? "license_check_now" : "license_gate");

			setGate(r);
			setLic(r.state);
		} catch (e: any) {
			setGate({
				allowed: false,
				reason: `gate_error:${toAppError(e).code}`,
				state: null,
			});
			setLic(null);
		}
	}

	/**
	 * «Borrar y volver a activar», desde la pantalla de bloqueo. Si borrar falla, el error se enseña en
	 * esa misma pantalla: tras el fallo la licencia sigue bloqueando, así que sin él se volvería a la
	 * misma pantalla sin ninguna explicación.
	 */
	function borrarYVolverAActivar() {
		setErrorAlBorrar(null);
		invokeClient("license_clear_state")
			.catch((e: unknown) => setErrorAlBorrar(toAppError(e).message))
			.finally(() => {
				void refrescarLicencia().finally(() => refrescarGate(false));
			});
	}

	useEffect(() => {
		void refrescarLicencia();
	}, []);

	useEffect(() => {
		if (modo === "tpv") {
			void refrescarGate(false);
		} else {
			setGate("loading");
		}
	}, [modo]);

	useEffect(() => {
		if (modo !== "tpv") return;

		let vivo = true;
		let desuscribir: (() => void) | null = null;

		void listen<LicenseGateResult>("license:changed", (ev) => {
			if (!vivo) return;
			setGate(ev.payload);
			setLic(ev.payload.state);
		}).then((un) => {
			if (vivo) desuscribir = un;
			else un();
		});

		return () => {
			vivo = false;
			desuscribir?.();
		};
	}, [modo]);

	return { lic, gate, errorAlBorrar, refrescarLicencia, refrescarGate, borrarYVolverAActivar };
}
