import { ImageOff, X } from "lucide-react";
import React, { useEffect, useState } from "react";
import { cn } from "../../shared/lib/cn";
import { conAviso } from "../../shared/lib/conAviso";
import { eur } from "../../shared/lib/dinero";
import ImageWithFallback from "../../shared/ui/ImageWithFallback";
import type { ProductoDisplay } from "./tiposComanda";

export function Modal({
    open,
    title,
    children,
    onClose,
    headerRight,
}: {
    open: boolean;
    title: string;
    children: React.ReactNode;
    onClose: () => void;
    headerRight?: React.ReactNode;
}) {
    if (!open) return null;
    return (
        <div className="fixed inset-0 z-[9999] grid place-items-center bg-black/50 p-1.5 sm:p-2">
            {/* El ancho se declara con `--modal-width`, no sólo con `max-w-375`: el sistema común
                de modales de Global.css fuerza `width`/`max-width` con `!important` sobre todo
                `.fixed.inset-0 > .bg-surface`, así que una utilidad de Tailwind aquí no gana. Sin
                esto, esta modal se queda en los 42rem del resto y su contenido no cabe: el panel
                del ticket sale cortado y los botones del contador de efectivo se aplastan a 12 px.
                Este no es un diálogo de formulario, es la pantalla de trabajo de la comanda. */}
            <div className="flex h-[calc(100dvh-0.75rem)] w-full max-w-375 [--modal-width:93.75rem] flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-xl sm:h-[min(90dvh, 900px)]">
                <div className="flex items-center justify-between gap-3 border-b border-border p-3 sm:p-4">
                    <div className="text-lg font-extrabold text-fg">
                        {title}
                    </div>
                    <div className="flex items-center gap-2">
                        {headerRight}
                        <button
                            onClick={onClose}
                            aria-label="Cerrar"
                            className="grid size-10 cursor-pointer place-items-center rounded-xl border border-border bg-surface text-fg-muted transition hover:bg-surface-2 hover:text-fg"
                        >
                            <X className="size-4" aria-hidden />
                        </button>
                    </div>
                </div>

                <div className="min-h-0 flex-1 p-2 sm:p-4">{children}</div>
            </div>
        </div>
    );
}

/* =========================
   Modal para nota por línea
========================= */
export function NotaLineaModal({
    open,
    productoNombre,
    initialValue,
    onCancel,
    onSave,
}: {
    open: boolean;
    productoNombre: string;
    initialValue: string;
    onCancel: () => void;
    onSave: (nota: string) => void | Promise<void>;
}) {
    const [value, setValue] = useState(initialValue);

    useEffect(() => {
        if (open) setValue(initialValue);
    }, [open, initialValue]);

    if (!open) return null;

    return (
        <div className="fixed inset-0 z-[10000] grid place-items-center bg-black/50 p-2 sm:p-4">
            <div className="w-full max-w-[520px] rounded-2xl border border-border bg-surface shadow-xl overflow-hidden">
                <div className="flex items-center justify-between gap-3 border-b border-border p-3 sm:p-4">
                    <div className="min-w-0">
                        <p className="text-sm text-fg-subtle font-semibold">
                            Nota de producto
                        </p>
                        <p className="text-lg font-extrabold text-fg truncate">
                            {productoNombre}
                        </p>
                    </div>

                    <button
                        type="button"
                        onClick={onCancel}
                        title="Cerrar"
                        aria-label="Cerrar"
                        className="grid size-10 cursor-pointer place-items-center rounded-xl border border-border bg-surface text-fg-muted transition hover:bg-surface-2 hover:text-fg"
                    >
                        <X className="size-4" aria-hidden />
                    </button>
                </div>

                <div className="p-3 sm:p-4">
                    <textarea
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        onKeyDown={(e) => {
                            const isEnter = e.key === "Enter";
                            const isModifier = e.ctrlKey || e.metaKey;
                            if (isEnter && isModifier) {
                                e.preventDefault();
                                void onSave(value);
                            }
                        }}
                        placeholder='Ej: "Sin queso", "Muy hecho", "Sin sal"...'
                        className="w-full min-h-[140px] resize-none rounded-xl border border-border bg-surface px-3 py-3 outline-none focus:ring-2 focus:ring-ring"
                    />
                    <p className="mt-2 text-xs text-fg-subtle">
                        Tip: pulsa <span className="font-semibold">Ctrl + Enter</span> para
                        guardar rápidamente
                    </p>

                    <div className="mt-4 grid grid-cols-2 gap-2 sm:flex sm:items-center sm:justify-end">
                        <button
                            type="button"
                            onClick={onCancel}
                            className="px-4 py-2 rounded-xl border border-border bg-surface hover:bg-surface-2 text-sm font-semibold"
                        >
                            Cancelar
                        </button>

                        <button
                            type="button"
                            onClick={conAviso(() => onSave(value))}
                            className="px-4 py-2 rounded-xl bg-accent text-white hover:bg-accent-hover text-sm font-semibold"
                        >
                            Guardar
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}


/**
 * `bloqueado`: no admite toques (se está cobrando). `abriendo`: la mesa todavía se está abriendo; los
 * toques sí entran —la pantalla los apunta y los añade al terminar—, pero la tarjeta se ve apagada
 * para que se note que aún no está lista.
 */
export const ProductCard = React.memo(function ProductCard({
    p,
    qty,
    onAdd,
    onRemove,
    onInfo,
    bloqueado,
    abriendo = false,
}: {
    bloqueado: boolean;
    abriendo?: boolean;
    p: ProductoDisplay;
    qty: number;
    onAdd: (p: ProductoDisplay) => void;
    onRemove: (productoId: string) => void;
    onInfo: (p: ProductoDisplay) => void;
}) {
    return (
        <div className={cn(
            "rounded-xl border border-border bg-surface p-3 text-left transition-opacity",
            (bloqueado || abriendo) && "opacity-60",
        )}>
            <div
                role="button"
                tabIndex={bloqueado ? -1 : 0}
                aria-disabled={bloqueado}
                aria-busy={abriendo}
                onClick={() => { if (!bloqueado) onAdd(p); }}
                onKeyDown={(e) => {
                    if (!bloqueado && (e.key === "Enter" || e.key === " ")) {
                        e.preventDefault();
                        onAdd(p);
                    }
                }}
                className={cn(
                    "w-full text-left hover:opacity-95 transition outline-none",
                    bloqueado ? "cursor-not-allowed" : "cursor-pointer",
                )}
            >
                <div className="relative">
                    <ImageWithFallback
                        src={p.urlImagen}
                        alt={p.Nombre}
                        className="w-full h-28 object-cover rounded-lg border border-border"
                        fallback={
                            <div className="flex h-28 w-full items-center justify-center rounded-lg border border-border bg-surface-2 text-fg-subtle">
                                <ImageOff className="size-6" aria-hidden />
                            </div>
                        }
                    />

                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            onInfo(p);
                        }}
                        className="absolute top-2 right-2 w-8 h-8 rounded-full bg-surface/90 border border-border shadow-sm flex items-center justify-center text-fg-muted hover:bg-surface transition"
                        title="Info"
                        aria-label={`Info de ${p.Nombre}`}
                    >
                        ℹ️
                    </button>

                    {qty > 0 ? (
                        <div className="absolute -top-2 -left-2 w-8 h-8 rounded-full bg-accent text-white flex items-center justify-center text-sm font-bold border-2 border-border">
                            {qty}
                        </div>
                    ) : null}
                </div>

                <div className="mt-2 flex items-start justify-between gap-2">
                    <p className="font-semibold leading-tight">{p.Nombre}</p>
                    <span className="text-sm font-bold">
                        {eur(p.Precio_Venta)}
                    </span>
                </div>
            </div>

            <div className="mt-3 flex items-center justify-between gap-2">
                <button
                    type="button"
                    onClick={() => onRemove(p.ID_Producto)}
                    className={cn(
                        "w-11 h-11 rounded-xl border border-border bg-surface hover:bg-surface-2 font-bold",
                        qty === 0 && "opacity-40 cursor-not-allowed",
                    )}
                    disabled={qty === 0 || bloqueado || abriendo}
                >
                    −
                </button>

                <div className="flex-1 text-center rounded-xl border border-border bg-surface-2 py-2">
                    <p className="text-xs text-fg-muted">Cantidad</p>
                    <p className="text-lg font-bold">{qty}</p>
                </div>

                <button
                    type="button"
                    onClick={() => { if (!bloqueado) onAdd(p); }}
                    disabled={bloqueado}
                    className="w-11 h-11 rounded-xl border border-border bg-surface hover:bg-surface-2 font-bold"
                >
                    +
                </button>
            </div>
        </div>
    );
});
