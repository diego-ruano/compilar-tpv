import { commands } from "@tpv/client";
// RI-31/RI-57: puente de presentación. El transporte, SQL y confirmaciones viven en Rust.

import { listen } from "@tauri-apps/api/event";
import type { CambioReplicado, EstadoReplicacion } from "@tpv/contracts";
import { useEstadoSync, type EstadoSync, type FaseRecuperacion, type PreferenciaSync } from "../stores/useEstadoSync";
import type { ModeStateValue } from "../stores/useMode";
import { useSyncSignal } from "../stores/useSyncSignal";
import { queryClient } from "./queryClient";
import { claveDeConsulta, featureKeysPorTablas } from "./syncStatements";
import { recargarAjustes } from "./recargarAjustes";
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
        // Si los Handy siguen esperando a esta Main: lo dice Conectividad (`textoDeConexion`).
        const retenidas = foto.handy_retenidas === true;
        if (store.handyRetenidas !== retenidas) useEstadoSync.setState({ handyRetenidas: retenidas });
        // SYNC-32: la sesión se ha detenido porque esta base es anterior a lo que guarda la nube, y
        // el backend la ha pasado a recuperarse de la nube. La pantalla lo sabe releyendo el estado.
        if (foto.estado === "detenida") {
            commands.recoveryStatus()
                .then((r) => {
                    if (!detenido) useEstadoSync.getState().configurarRecuperacion(r.state);
                })
                .catch((e: unknown) => captureException(e, { fase: "releer_recuperacion" }));
        }
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
                else for (const key of keys) void queryClient.invalidateQueries({ queryKey: claveDeConsulta(key) });
                useSyncSignal.getState().bump(payload.comanda, payload.tablas);
                // El store de la tabla que una Handy ha cambiado (también los datos de contacto).
                recargarAjustes(payload.tablas);
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
