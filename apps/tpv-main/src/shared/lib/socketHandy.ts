// RI-31: puente de presentación. Rust conserva el socket, los tiempos y la identidad.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AvisoSocketHandy, EstadoSocketHandy } from "@tpv/contracts";
import { useMainPresence } from "../stores/useMainPresence";
import { useSyncSignal } from "../stores/useSyncSignal";
import type { ModeStateValue } from "../stores/useMode";
import { queryClient } from "./queryClient";
import { featureKeysPorTablas, ajustesPorTablas } from "./syncStatements";
import { useBusinessSettings } from "../stores/useBusinessSettings";
import { useTicketSettings } from "../stores/useTicketSettings";
import { captureException } from "../observability/sentry";

export type SocketHandy = { reconectarSiHaceFalta: (forzar?: boolean) => void; detener: () => void };

export function iniciarSocketHandy(modo: ModeStateValue): SocketHandy | null {
    if (modo !== "handy") return null;
    let detenido = false;
    let revision = -1;
    let generacion = -1;
    const quitar: (() => void)[] = [];
    const publicar = (foto: EstadoSocketHandy) => {
        if (detenido || foto.revision < revision) return;
        revision = foto.revision;
        generacion = foto.generacion;
        useMainPresence.setState({ mainOnline: foto.main_online, volcando: foto.volcando, rechazo: foto.rechazo });
    };
    const observar = async () => {
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
        publicar(await invoke<EstadoSocketHandy>("handy_socket_estado"));
    };
    void observar().catch((e) => { if (!detenido) captureException(e, { fase: "observar_handy_nativo" }); });
    return {
        reconectarSiHaceFalta: (forzar = false) => {
            if (!detenido) void invoke("handy_socket_reintentar", { forzar }).catch((e) => captureException(e, { fase: "reintentar_handy_nativo" }));
        },
        // Desmontar una vista no detiene el servicio de la aplicación.
        detener: () => { detenido = true; for (const unlisten of quitar) unlisten(); },
    };
}
