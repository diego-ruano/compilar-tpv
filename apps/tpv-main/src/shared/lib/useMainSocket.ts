// RI-31: observa la réplica nativa y comunica señales de conectividad del navegador.
import { useEffect } from "react";

import { useEstadoSync } from "../stores/useEstadoSync";
import { useMode } from "../stores/useMode";
import { iniciarSocketMain } from "./socketMain";

export function useMainSocket() {
	const preferencia = useEstadoSync((s) => s.preferencia);
	const hidratada = useEstadoSync((s) => s.hidratada);
	const datosPerdidos = useEstadoSync((s) => s.datosPerdidos);
	const reconciliacionPendiente = useEstadoSync((s) => s.reconciliacionPendiente);
	const deviceMode = useMode((s) => s.mode);

	useEffect(() => {
		const socket = iniciarSocketMain({
			modo: deviceMode,
			hidratada,
			preferencia,
			datosPerdidos,
			reconciliacionPendiente,
		});
		if (!socket) return;

		// SYNC-17: re-disparo de la reconexión cuando vuelve la red o la ventana recupera el foco.
		// En escritorio importa igual que en móvil: al despertar de suspensión el socket está muerto
		// y el backoff puede ir por 30 s.
		//
		// Envoltorios con nombre: los listeners del DOM reciben el Event como primer argumento, y
		// pasárselo tal cual a `reconectarSiHaceFalta` lo leería como `forzar = true`.
		const alVolverLaRed = () => socket.reconectarSiHaceFalta(false);
		const onVisibility = () => {
			if (document.visibilityState === "visible") socket.reconectarSiHaceFalta(false);
		};
		document.addEventListener("visibilitychange", onVisibility);
		window.addEventListener("online", alVolverLaRed);
		window.addEventListener("focus", alVolverLaRed);

		// SYNC-17: `pulso` es "inténtalo ya". Lo sube AppBoot en cuanto el gate de licencia deja
		// pasar (activación recién hecha, licencia renovada), que es justo cuando `sin_identidad` o
		// `rechazado` dejan de ser ciertos y su espera larga sobra. Se observa por suscripción y no
		// como dependencia del efecto para no derribar un socket que ya esté sano.
		let ultimoPulso = useEstadoSync.getState().pulso;
		const unsubPulso = useEstadoSync.subscribe((s) => {
			if (s.pulso === ultimoPulso) return;
			ultimoPulso = s.pulso;
			socket.reconectarSiHaceFalta(true);
		});

		return () => {
			unsubPulso();
			document.removeEventListener("visibilitychange", onVisibility);
			window.removeEventListener("online", alVolverLaRed);
			window.removeEventListener("focus", alVolverLaRed);
			socket.detener();
		};
	}, [deviceMode, preferencia, hidratada, datosPerdidos, reconciliacionPendiente]);
}
