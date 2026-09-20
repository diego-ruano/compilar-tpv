// src/features/cuentas/ImpactoCierreModal.tsx
//
// El aviso antes de tocar un apunte que pertenece a un cierre de caja ya hecho (CAJA-01).
//
// No bloquea nada: enseña qué cierres cambian y cómo quedan, y pide el motivo sólo si algún
// descuadre se mueve. El backend vuelve a comprobar que haya motivo; esto está para que se vea antes
// de decidir, que es cuando sirve.

import { useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import type { ImpactoCajaDto } from "@tpv/contracts";

import { ModalShell } from "../../shared/ui";
import { cn } from "../../shared/lib/cn";
import { euro } from "./formato";
import { abs } from "../../shared/lib/dinero";
import type { Dinero } from "@tpv/contracts";

type Props = {
    impacto: ImpactoCajaDto;
    /** El motivo ya se ha escrito en otro sitio: anular un cobro lo pide siempre. */
    motivoYaDado?: boolean;
    guardando?: boolean;
    error?: string | null;
    onCancelar: () => void;
    onConfirmar: (motivo: string | null) => void;
};

function descuadreEnPalabras(d: Dinero): string {
    if (Math.round(d * 100) === 0) return "cuadra";
    return d < 0 ? `faltan ${euro(abs(d))}` : `sobran ${euro(d)}`;
}

export default function ImpactoCierreModal({
    impacto,
    motivoYaDado = false,
    guardando = false,
    error = null,
    onCancelar,
    onConfirmar,
}: Props) {
    const [motivo, setMotivo] = useState("");

    const pideMotivo = impacto.requiere_motivo && !motivoYaDado;
    const puede = !guardando && (!pideMotivo || motivo.trim().length > 0);
    const varios = impacto.cierres.length > 1;

    return (
        <ModalShell
            open
            onClose={() => (guardando ? null : onCancelar())}
            className="fixed inset-0 z-[70] flex items-center justify-center"
        >
            <div
                className="absolute inset-0 bg-black/40"
                onClick={() => (guardando ? null : onCancelar())}
            />

            <div className="relative w-[560px] max-w-[92vw] rounded-3xl border border-border bg-surface p-6 shadow-xl">
                <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-3">
                        <div className="grid size-10 shrink-0 place-items-center rounded-2xl bg-warning-soft text-warning">
                            <AlertTriangle className="size-5" aria-hidden />
                        </div>
                        <div className="min-w-0">
                            <h3 className="text-lg font-semibold text-fg">
                                {varios
                                    ? "Esto cambia cierres de caja ya hechos"
                                    : "Esto cambia un cierre de caja ya hecho"}
                            </h3>
                            <p className="text-sm text-fg-muted">
                                Se puede hacer. Lo que se contó esa noche no se toca: el cierre guardará
                                al lado lo que marca ahora, quién lo cambió y por qué.
                            </p>
                        </div>
                    </div>

                    <button
                        type="button"
                        className="grid size-9 cursor-pointer place-items-center rounded-xl border border-border bg-surface text-fg-muted transition hover:bg-surface-2 hover:text-fg"
                        onClick={() => (guardando ? null : onCancelar())}
                        title="Cancelar"
                    >
                        <X className="size-4" aria-hidden />
                    </button>
                </div>

                <div className="mt-4 grid gap-2">
                    {impacto.cierres.map((c) => {
                        const cambia =
                            Math.round(c.descuadre_antes * 100) !== Math.round(c.descuadre_despues * 100);
                        return (
                            <div
                                key={c.id_cierre}
                                className="rounded-2xl border border-border bg-surface-2 px-4 py-3 text-sm"
                            >
                                <div className="font-semibold text-fg">Cierre del {c.fecha_hora}</div>
                                {cambia ? (
                                    <div className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-fg-muted">
                                        <span>Debería haber</span>
                                        <span className="text-right text-fg">
                                            {euro(c.esperado_antes)} → {euro(c.esperado_despues)}
                                        </span>
                                        <span>Diferencia</span>
                                        <span
                                            className={cn(
                                                "text-right font-semibold",
                                                Math.round(c.descuadre_despues * 100) === 0
                                                    ? "text-success"
                                                    : "text-danger",
                                            )}
                                        >
                                            {descuadreEnPalabras(c.descuadre_antes)} →{" "}
                                            {descuadreEnPalabras(c.descuadre_despues)}
                                        </span>
                                    </div>
                                ) : (
                                    <p className="mt-1 text-fg-muted">
                                        Su arqueo no cambia, pero sí los totales de ese periodo.
                                    </p>
                                )}
                            </div>
                        );
                    })}
                </div>

                {pideMotivo ? (
                    <label className="mt-4 block">
                        <span className="text-sm font-semibold text-fg">
                            Motivo (obligatorio: cambia lo que cuadró esa noche)
                        </span>
                        <input
                            type="text"
                            autoFocus
                            value={motivo}
                            onChange={(ev) => setMotivo(ev.target.value)}
                            placeholder="Era con tarjeta, la factura llegó tarde…"
                            disabled={guardando}
                            className={cn(
                                "mt-1 h-10 w-full rounded-xl border bg-surface px-3 text-sm text-fg outline-none focus:border-accent",
                                motivo.trim() ? "border-border" : "border-danger",
                            )}
                        />
                    </label>
                ) : null}

                {error ? (
                    <div className="mt-3 rounded-2xl border border-danger/30 bg-danger-soft px-4 py-2 text-sm text-danger">
                        {error}
                    </div>
                ) : null}

                <div className="mt-6 flex items-center justify-end gap-2">
                    <button
                        type="button"
                        disabled={guardando}
                        onClick={onCancelar}
                        className={cn(
                            "h-10 rounded-xl border border-border bg-surface px-4 text-sm font-semibold text-fg shadow-sm hover:bg-surface-2 active:scale-[0.97]",
                            guardando && "cursor-not-allowed opacity-60",
                        )}
                    >
                        Cancelar
                    </button>
                    <button
                        type="button"
                        disabled={!puede}
                        onClick={() => onConfirmar(pideMotivo ? motivo.trim() : null)}
                        className={cn(
                            "h-10 rounded-xl border border-accent bg-accent px-5 text-sm font-bold text-white shadow-sm hover:bg-accent-hover active:scale-[0.97]",
                            !puede && "cursor-not-allowed opacity-60",
                        )}
                    >
                        {guardando ? "Guardando…" : "Sí, hacer el cambio"}
                    </button>
                </div>
            </div>
        </ModalShell>
    );
}
