// src/features/cuentas/CasillaTicket.tsx
import { Check } from "lucide-react";

/**
 * La casilla de un cobro cuando se eligen varios tickets para una sola factura. Con `motivo`, el
 * ticket no se puede facturar (DOC-INC-01): la casilla sale desactivada y dice por qué.
 */
export default function CasillaTicket({
    marcada,
    motivo,
    onClick,
}: {
    marcada: boolean;
    motivo?: string | null;
    onClick: () => void;
}) {
    if (motivo) {
        return (
            <span className="flex items-center gap-1.5">
                <span className="text-[11px] font-semibold text-fg-muted">{motivo}</span>
                <button
                    type="button"
                    disabled
                    title={motivo}
                    aria-label={`No se puede añadir a la factura: ${motivo}`}
                    className="h-9 w-9 cursor-not-allowed rounded-xl border border-border bg-surface-2 opacity-50"
                />
            </span>
        );
    }
    return (
        <button
            type="button"
            title={marcada ? "Quitar de la factura" : "Añadir a la factura"}
            aria-pressed={marcada}
            onClick={onClick}
            className={[
                "h-9 w-9 rounded-xl border shadow-sm transition active:scale-[0.98] grid place-items-center",
                marcada
                    ? "border-accent bg-accent text-white"
                    : "border-border bg-surface text-fg-muted hover:bg-surface-2",
            ].join(" ")}
        >
            {marcada ? <Check className="size-4" aria-hidden /> : null}
        </button>
    );
}
