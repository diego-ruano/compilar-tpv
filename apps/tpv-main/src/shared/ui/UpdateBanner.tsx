// shared/ui/UpdateBanner.tsx
//
// Aviso de actualización disponible. La DETECCIÓN la hace el backend (Rust) y es la fuente de
// verdad: al arrancar emite `update:available`. Este componente además consulta una vez por su
// cuenta (`updater_check`) por si se montó después de ese evento. La INSTALACIÓN nunca es
// automática: el usuario pulsa "Actualizar" cuando le conviene (p. ej. al cerrar caja), para no
// reiniciar el TPV en mitad de un servicio.
//
// Se monta una sola vez en AppBoot y se renderiza por encima de todo. Si no hay actualización,
// no pinta nada. Es tolerante a fallos: en modo dev o sin feed, los errores se ignoran.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { conAviso } from "../lib/conAviso";

type UpdateInfo = {
    version: string;
    current_version: string;
    notes: string | null;
};

export default function UpdateBanner() {
    const [update, setUpdate] = useState<UpdateInfo | null>(null);
    const [installing, setInstalling] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [dismissed, setDismissed] = useState(false);

    useEffect(() => {
        let alive = true;

        // 1) Comprobación propia al montar (cubre el caso de montarse tras el evento de arranque).
        invoke<UpdateInfo | null>("updater_check")
            .then((info) => {
                if (alive && info) setUpdate(info);
            })
            .catch(() => {
                /* dev / sin feed / offline: sin aviso, se reintenta en el próximo arranque */
            });

        // 2) Evento emitido por el chequeo de arranque del backend.
        const unlistenPromise = listen<UpdateInfo>("update:available", (e) => {
            if (alive) setUpdate(e.payload);
        });

        return () => {
            alive = false;
            void unlistenPromise.then((un) => un());
        };
    }, []);

    if (!update || dismissed) return null;

    async function handleInstall() {
        setInstalling(true);
        setError(null);
        try {
            // Descarga + verifica firma + instala + reinicia. Si todo va bien, la app se reinicia
            // y este componente desaparece con ella; por eso no hay un "éxito" que pintar.
            await invoke("updater_install");
        } catch (e: any) {
            setError(String(e?.message || e));
            setInstalling(false);
        }
    }

    return (
        <div className="fixed bottom-3 right-3 z-[1000] w-full max-w-sm rounded-2xl border border-[#2B81D4] bg-white p-4 shadow-lg">
            <div className="flex items-start gap-3">
                <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-[#016FFC]/10 text-[#0F2C56]">
                    ↑
                </div>
                <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-slate-900">
                        Nueva versión disponible
                    </div>
                    <div className="mt-0.5 text-xs text-slate-600">
                        Versión {update.version}
                        {update.current_version
                            ? ` (tienes la ${update.current_version})`
                            : ""}
                        .
                    </div>
                    {update.notes ? (
                        <div className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap text-xs text-slate-500">
                            {update.notes}
                        </div>
                    ) : null}

                    {error ? (
                        <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">
                            {error}
                        </div>
                    ) : null}

                    <div className="mt-3 flex gap-2">
                        <button
                            type="button"
                            onClick={conAviso(handleInstall)}
                            disabled={installing}
                            className="rounded-xl bg-[#016FFC] px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-[#2B81D4] disabled:opacity-50"
                        >
                            {installing ? "Actualizando…" : "Actualizar y reiniciar"}
                        </button>
                        <button
                            type="button"
                            onClick={() => setDismissed(true)}
                            disabled={installing}
                            className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
                        >
                            Más tarde
                        </button>
                    </div>

                    <div className="mt-2 text-[11px] text-slate-400">
                        Si lo dejas para luego, la tienes en Configuración → Actualizaciones.
                    </div>
                </div>
            </div>
        </div>
    );
}
