import React, { useState } from "react";
import { toAppError } from "@tpv/client";

import Modal from "./Modal";
import { useToast } from "../../../shared/toast";
import { conAviso } from "../../../shared/lib/conAviso";

/**
 * Ajustar las existencias de un lote o el stock suelto de un producto: un recuento, una merma, una
 * rotura (RI-55).
 *
 * Manda **lo que se veía** al abrir (`actual`) además de lo que hay ahora. Si entre medias alguien
 * vendió o ajustó, el backend lo rechaza en vez de pisarlo, y aquí se avisa para volver a mirar.
 *
 * Se monta sólo mientras está abierto: lo visto se toma de `actual` al montarse. Si `actual` cambia
 * mientras está abierto (lo ha cambiado otro equipo), el borrador se queda y se avisa; para ajustar
 * hay que partir de lo de ahora (INV-MEJ-02).
 */
type Props = {
    onClose: () => void;
    /** «Lote L-1 de Cerveza», «Stock suelto de Cerveza». */
    titulo: string;
    /** Lo que hay según la pantalla, al día. `null` = el producto no lleva stock suelto. */
    actual: number | null;
    /** Sólo el stock suelto: se puede dejar de llevar. */
    permiteDejarDeLlevar?: boolean;
    /** `visto`: lo que había al abrir (o al partir de lo de ahora), que el backend compara. */
    onConfirmar: (nuevo: number | null, motivo: string | null, visto: number | null) => Promise<void>;
};

function aNumero(v: string): number {
    const n = Number(String(v).replace(",", "."));
    return Number.isFinite(n) ? n : NaN;
}

export default function AjustarExistenciasModal({
    onClose,
    titulo,
    actual,
    permiteDejarDeLlevar = false,
    onConfirmar,
}: Props) {
    const toast = useToast();
    // Lo visto se fija al montar: es lo que el backend compara con lo que hay.
    const [visto, setVisto] = useState<number | null>(actual);
    const haCambiado = actual !== visto;
    const [nuevo, setNuevo] = useState(actual == null ? "" : String(actual));
    const [sinStock, setSinStock] = useState(actual == null && permiteDejarDeLlevar);
    const [motivo, setMotivo] = useState("");
    const [guardando, setGuardando] = useState(false);

    const cantidad = aNumero(nuevo);
    const valido = !haCambiado && (sinStock || (nuevo.trim() !== "" && Number.isFinite(cantidad) && cantidad >= 0));

    async function confirmar(e: React.FormEvent) {
        e.preventDefault();
        if (!valido || guardando) return;
        setGuardando(true);
        try {
            await onConfirmar(sinStock ? null : cantidad, motivo.trim() || null, visto);
            toast.success("OK", "Existencias ajustadas");
            onClose();
        } catch (err) {
            // Un «las existencias han cambiado» trae ya lo que hay ahora; se cierra para volver a
            // abrir con el dato nuevo en vez de reintentar con el viejo.
            toast.error("No se ha ajustado", toAppError(err).message);
            onClose();
        } finally {
            setGuardando(false);
        }
    }

    return (
        <Modal open onClose={() => !guardando && onClose()} title="Ajustar existencias" maxWidthClass="max-w-[520px]">
            <form onSubmit={conAviso(confirmar)} className="grid grid-cols-1 gap-3">
                <p className="text-sm font-semibold text-fg">{titulo}</p>
                <p className="text-sm text-fg-muted">
                    Ahora hay:{" "}
                    <span className="font-extrabold text-fg">
                        {visto == null ? "no lleva stock suelto" : String(visto)}
                    </span>
                </p>

                {haCambiado && (
                    <div role="alert" className="flex flex-col gap-2 rounded-xl border border-warning bg-warning-soft px-3 py-2 text-sm text-fg">
                        <p>
                            Ha cambiado mientras ajustabas: ahora hay{" "}
                            <span className="font-extrabold">{actual == null ? "no lleva stock suelto" : String(actual)}</span>.
                        </p>
                        <button
                            type="button"
                            onClick={() => setVisto(actual)}
                            disabled={guardando}
                            className="self-start cursor-pointer rounded-lg border border-border bg-surface px-3 py-1 font-semibold text-fg transition hover:bg-surface-2"
                        >
                            Partir de lo de ahora
                        </button>
                    </div>
                )}

                {permiteDejarDeLlevar && (
                    <label className="flex items-center gap-2 text-sm text-fg">
                        <input
                            type="checkbox"
                            checked={sinStock}
                            onChange={(e) => setSinStock(e.target.checked)}
                            disabled={guardando}
                        />
                        No llevar stock suelto de este producto
                    </label>
                )}

                {!sinStock && (
                    <div>
                        <label className="text-sm font-semibold text-fg">Hay en realidad *</label>
                        <input
                            type="number"
                            step="0.001"
                            min="0"
                            value={nuevo}
                            onChange={(e) => setNuevo(e.target.value)}
                            className="mt-1 w-full rounded-xl border border-border bg-surface-2 px-3 py-2 text-fg outline-none transition focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-ring"
                            disabled={guardando}
                            autoFocus
                        />
                    </div>
                )}

                <div>
                    <label className="text-sm font-semibold text-fg">Motivo</label>
                    <input
                        value={motivo}
                        onChange={(e) => setMotivo(e.target.value)}
                        placeholder="Recuento, merma, rotura…"
                        className="mt-1 w-full rounded-xl border border-border bg-surface-2 px-3 py-2 text-fg outline-none transition placeholder:text-fg-subtle focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-ring"
                        disabled={guardando}
                    />
                </div>

                <button
                    type="submit"
                    disabled={!valido || guardando}
                    className="mt-1 cursor-pointer rounded-xl bg-accent py-2 font-extrabold text-accent-fg shadow-sm transition hover:bg-accent-hover disabled:opacity-60"
                >
                    {guardando ? "Guardando..." : "Ajustar"}
                </button>
            </form>
        </Modal>
    );
}
