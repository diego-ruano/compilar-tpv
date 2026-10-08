import { useRef, useState } from "react";
import { toAppError } from "@tpv/client";
import { ModalShell } from "../../shared/ui";
import { conAviso } from "../../shared/lib/conAviso";

/** RI-82: confirmar antes de invalidar el recuento del último cierre. */
export default function ReabrirCierreModal({ onCancelar, onConfirmar }: {
    onCancelar: () => void;
    onConfirmar: () => Promise<void>;
}) {
    const enCurso = useRef(false);
    const [estado, setEstado] = useState<{ guardando: boolean; error: string | null }>({ guardando: false, error: null });
    const confirmar = async () => {
        if (enCurso.current) return;
        enCurso.current = true;
        setEstado({ guardando: true, error: null });
        try {
            await onConfirmar();
        } catch (e) {
            setEstado({ guardando: false, error: toAppError(e).message });
        } finally {
            enCurso.current = false;
        }
    };
    const cancelar = () => { if (!enCurso.current) onCancelar(); };
    return <ModalShell open onClose={cancelar}>
        <button aria-label="Cancelar reapertura" className="absolute inset-0 bg-black/50" onClick={cancelar} />
        <div className="relative w-full max-w-md rounded-2xl border border-border bg-surface p-6 shadow-xl">
            <h2 className="text-lg font-bold">¿Reabrir el cierre de caja?</h2>
            <p className="mt-3 text-fg-muted">El cierre quedará registrado como reabierto y tendrás que volver a contar el cajón para cerrarlo de nuevo.</p>
            {estado.error && <p role="alert" className="mt-3 text-danger">{estado.error}</p>}
            <div className="mt-5 flex justify-end gap-3">
                <button disabled={estado.guardando} className="rounded-xl border border-border px-4 py-2" onClick={cancelar}>Cancelar</button>
                <button disabled={estado.guardando} className="rounded-xl bg-accent px-4 py-2 text-accent-fg" onClick={conAviso(confirmar)}>{estado.guardando ? "Reabriendo…" : "Reabrir cierre"}</button>
            </div>
        </div>
    </ModalShell>;
}
