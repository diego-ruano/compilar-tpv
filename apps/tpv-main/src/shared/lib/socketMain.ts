import { commands } from "@tpv/client";
// RI-31/RI-57: puente de presentación. El transporte, SQL y confirmaciones viven en Rust.

import { listen } from "@tauri-apps/api/event";
import type { CambioReplicado, EstadoReplicacion } from "@tpv/contracts";
import { useEstadoSync, type EstadoSync, type FaseRecuperacion, type PreferenciaSync } from "../stores/useEstadoSync";
import type { ModeStateValue } from "../stores/useMode";
import { useSyncSignal } from "../stores/useSyncSignal";
import { queryClient } from "./queryClient";
import { featureKeysPorTablas, ajustesPorTablas } from "./syncStatements";
import { useBusinessSettings } from "../stores/useBusinessSettings";
import { useTicketSettings } from "../stores/useTicketSettings";
import { captureException } from "../observability/sentry";

export type EntradaSocketMain = {
    modo: ModeStateValue;
    hidratada: boolean;
    preferencia: PreferenciaSync;
    datosPerdidos: boolean;
    reconciliacionPendiente: boolean;
};
export type SocketMain = {
    reconectarSiHaceFalta: (forzar?: boolean) => void;
    detener: () => void;
};

export function iniciarSocketMain(entrada: EntradaSocketMain): SocketMain | null {
    if (entrada.modo !== "tpv" || !entrada.hidratada) return null;
    let detenido = false;
    let revision = -1;
    const quitar: (() => void)[] = [];
    const publicar = (foto: EstadoReplicacion) => {
        if (detenido || foto.revision < revision) return;
        revision = foto.revision;
        const store = useEstadoSync.getState();
        store.marcar(foto.estado as EstadoSync, foto.detalle);
        if (foto.fase_recuperacion === "completada") store.finalizarRecuperacion();
        else if (foto.fase_recuperacion !== "inactiva") {
            useEstadoSync.setState({ faseRecuperacion: foto.fase_recuperacion as FaseRecuperacion, fallosRecuperacion: foto.fallos_recuperacion, errorRecuperacion: foto.detalle });
        }
    };
    // Registrar antes de leer evita perder un cambio entre snapshot y suscripción.
    const observar = async () => {
        const resultados = await Promise.allSettled([
            listen<EstadoReplicacion>("sync:estado", (e) => publicar(e.payload)),
            listen<CambioReplicado>("sync:cambio", ({ payload }) => {
                if (detenido) return;
                const keys = featureKeysPorTablas(payload.tablas);
                if (keys === null) void queryClient.invalidateQueries();
                else for (const key of keys) void queryClient.invalidateQueries({ queryKey: [key] });
                useSyncSignal.getState().bump(payload.comanda);
                if (ajustesPorTablas(payload.tablas)) {
                    void useBusinessSettings.getState().init();
                    void useTicketSettings.getState().init();
                }
            }),
            listen("sync:pair-request", () => { if (!detenido) void queryClient.invalidateQueries({ queryKey: ["pairing"] }); }),
        ]);
        const registros = resultados.flatMap((r) => r.status === "fulfilled" ? [r.value] : []);
        const fallo = resultados.find((r) => r.status === "rejected");
        if (detenido || fallo) { for (const quitar of registros) quitar(); if (fallo?.status === "rejected") throw fallo.reason; return; }
        quitar.push(...registros);
        publicar(await commands.syncEstado());
        await commands.syncReintentar();
    };
    void observar().catch((e) => { if (!detenido) captureException(e, { fase: "observar_sync_nativo" }); });
    return {
        reconectarSiHaceFalta: () => { void commands.syncReintentar().catch((e) => captureException(e, { fase: "reintentar_sync_nativo" })); },
        // Desmontar la UI no interrumpe una transacción ni detiene la réplica.
        detener: () => { detenido = true; for (const unlisten of quitar) unlisten(); },
    };
}
