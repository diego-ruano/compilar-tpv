// src/shared/lib/useHandySocket.ts
//
// El WebSocket del Handy, montado en React. Lo que hace el socket —conectar, vigilar la presencia de
// la Main, refrescar al llegar un cambio— vive en `socketHandy.ts`, fuera de React, para poder
// probarlo sin montar nada. Aquí sólo queda lo que depende de React y del navegador:
//
//   · arrancarlo de nuevo cuando cambia el modo o se pulsa «Reintentar» (`retryTick`), que abre una
//     conexión fresca: el equivalente a recargar la página en escritorio;
//   · avisarle de que conviene reconectar ya: la app vuelve a primer plano, vuelve la red o recupera
//     el foco. En móvil es lo que evita quedarse en «Conectando», porque no hay recarga.

import { useEffect } from "react";

import { useMainPresence } from "../stores/useMainPresence";
import { useMode } from "../stores/useMode";
import { iniciarSocketHandy } from "./socketHandy";

export function useHandySocket() {
	const deviceMode = useMode((s) => s.mode);
	const retryTick = useMainPresence((s) => s.retryTick);

	useEffect(() => {
		const socket = iniciarSocketHandy(deviceMode);
		if (!socket) return;

		const alVolverLaRed = () => socket.reconectarSiHaceFalta();
		const onVisibility = () => {
			if (document.visibilityState === "visible") socket.reconectarSiHaceFalta();
		};
		document.addEventListener("visibilitychange", onVisibility);
		window.addEventListener("online", alVolverLaRed);
		window.addEventListener("focus", alVolverLaRed);

		return () => {
			document.removeEventListener("visibilitychange", onVisibility);
			window.removeEventListener("online", alVolverLaRed);
			window.removeEventListener("focus", alVolverLaRed);
			socket.detener();
		};
	}, [deviceMode, retryTick]);
}
