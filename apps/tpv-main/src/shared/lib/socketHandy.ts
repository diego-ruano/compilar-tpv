import { commands } from "@tpv/client";
// RI-31: puente de presentación. Rust conserva el socket, los tiempos y la identidad.

import { listen } from "@tauri-apps/api/event";
import type { AvisoSocketHandy, EstadoSocketHandy } from "@tpv/contracts";
import { useMainPresence } from "../stores/useMainPresence";
import { useSyncSignal } from "../stores/useSyncSignal";
import type { ModeStateValue } from "../stores/useMode";
import { queryClient } from "./queryClient";
import { featureKeysPorTablas, ajustesPorTablas } from "./syncStatements";
import { useBusinessSettings } from "../stores/useBusinessSettings";
import { useTicketSettings } from "../stores/useTicketSettings";
import { useContactSettings } from "../stores/useContactSettings";
import { limpiarSesionLocal } from "../stores/useAuth";
import { limpiarCacheImagenes } from "./imageUrl";
import { captureException } from "../observability/sentry";

export type SocketHandy = { reconectarSiHaceFalta: (forzar?: boolean) => void; detener: () => void };

export function iniciarSocketHandy(modo: ModeStateValue): SocketHandy | null {
    if (modo !== "handy") return null;
    let detenido = false;
    let revision = -1;
    let generacion = -1;
    let primeraFoto = true;
    let observando = false;
    let observada = false;
    const quitar: (() => void)[] = [];
    const publicar = (foto: EstadoSocketHandy) => {
        if (detenido || foto.revision < revision) return;
        revision = foto.revision;
        generacion = foto.generacion;
        const anterior = useMainPresence.getState();
        const nuevoContexto = anterior.generacion !== foto.generacion;
        if (nuevoContexto) {
            limpiarSesionLocal();
            limpiarCacheImagenes();
            useBusinessSettings.getState().limpiarContexto();
            useTicketSettings.getState().limpiarContexto();
            useContactSettings.getState().limpiarContexto();
        }
        const lista = foto.estado === "conectada" && foto.main_online === true && !foto.volcando;
        const antesLista = anterior.estadoConexion === "conectada" && anterior.mainOnline === true && !anterior.volcando;
        useMainPresence.setState({ mainOnline: foto.main_online, volcando: foto.volcando, rechazo: foto.rechazo,
            generacion: foto.generacion, conexion: foto.conexion, tenantId: foto.tenant_id, estadoConexion: foto.estado });
        if (lista && (primeraFoto || nuevoContexto || !antesLista || anterior.conexion !== foto.conexion)) {
            // Handy lee por HTTP: recuperar avisos perdidos requiere releer, no replicar un outbox.
            void queryClient.invalidateQueries();
            useSyncSignal.getState().bump();
            void useBusinessSettings.getState().init();
            void useTicketSettings.getState().init();
            void useContactSettings.getState().init();
        }
        primeraFoto = false;
    };
    const observar = async () => {
        if (detenido || observando || observada) return;
        observando = true;
        try {
            const registros = await Promise.allSettled([
                listen<EstadoSocketHandy>("handy:estado", ({ payload }) => publicar(payload)),
                listen<AvisoSocketHandy>("handy:cambio", ({ payload }) => {
                    if (detenido || payload.generacion !== generacion) return;
                    const cambio = payload.cambio;
                    const keys = featureKeysPorTablas(cambio.tablas);
                    if (keys === null) void queryClient.invalidateQueries();
                    else for (const key of keys) void queryClient.invalidateQueries({ queryKey: [key] });
                    useSyncSignal.getState().bump(cambio.comanda);
                    if (ajustesPorTablas(cambio.tablas)) {
                        void useBusinessSettings.getState().init();
                        void useTicketSettings.getState().init();
                        void useContactSettings.getState().init();
                    }
                }),
            ]);
            const listeners = registros.flatMap((r) => r.status === "fulfilled" ? [r.value] : []);
            const fallo = registros.find((r) => r.status === "rejected");
            if (detenido || fallo) {
                for (const unlisten of listeners) unlisten();
                if (fallo?.status === "rejected") throw fallo.reason;
                return;
            }
            quitar.push(...listeners);
            observada = true;
            publicar(await commands.handySocketEstado());
        } finally { observando = false; }
    };
    const falloObservacion = (e: unknown) => {
        if (detenido) return;
        useMainPresence.setState({ mainOnline: null, volcando: false });
        captureException(e, { fase: "observar_handy_nativo" });
    };
    void observar().catch(falloObservacion);
    return {
        reconectarSiHaceFalta: (forzar = false) => {
            if (!detenido && !observada) void observar().catch(falloObservacion);
            if (!detenido) void commands.handySocketReintentar(forzar).catch((e) => captureException(e, { fase: "reintentar_handy_nativo" }));
        },
        // Desmontar una vista no detiene el servicio de la aplicación.
        detener: () => { detenido = true; for (const unlisten of quitar) unlisten(); },
    };
}
