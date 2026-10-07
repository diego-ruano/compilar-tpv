// La UI observa el servicio nativo. El foco y la reanudación móvil los recibe Rust de Tauri.
import { useEffect, useRef } from "react";
import { useMainPresence } from "../stores/useMainPresence";
import { useMode } from "../stores/useMode";
import { iniciarSocketHandy, type SocketHandy } from "./socketHandy";

export function useHandySocket() {
    const modo = useMode((s) => s.mode);
    const retryTick = useMainPresence((s) => s.retryTick);
    const puente = useRef<SocketHandy | null>(null);
    const ultimoReintento = useRef(retryTick);
    useEffect(() => {
        const socket = iniciarSocketHandy(modo);
        puente.current = socket;
        if (!socket) return;
        // Es sólo una pista de red. La decisión y los temporizadores pertenecen a Rust.
        const alVolverLaRed = () => socket.reconectarSiHaceFalta();
        window.addEventListener("online", alVolverLaRed);
        return () => {
            window.removeEventListener("online", alVolverLaRed);
            socket.detener();
            puente.current = null;
        };
    }, [modo]);
    useEffect(() => {
        if (retryTick === ultimoReintento.current) return;
        ultimoReintento.current = retryTick;
        puente.current?.reconectarSiHaceFalta(true);
    }, [retryTick]);
}
