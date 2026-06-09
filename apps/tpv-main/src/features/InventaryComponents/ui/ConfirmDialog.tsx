// components/ui/ConfirmDialog.tsx
import React from "react";

export default function ConfirmDialog({
    open,
    title = "Confirmar",
    message,
    confirmText = "Eliminar",
    cancelText = "Cancelar",
    danger = true,
    loading = false,
    onCancel,
    onConfirm,
}: {
    open: boolean;
    title?: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    danger?: boolean;
    loading?: boolean;
    onCancel: () => void;
    onConfirm: () => void;
}) {
    if (!open) return null;

    return (
        <div
            className="fixed inset-0 z-[60] bg-black/50 flex items-end sm:items-center justify-center p-2 sm:p-4"
            onMouseDown={(e) => {
                if (e.target === e.currentTarget) onCancel();
            }}
        >
            <div className="w-full max-w-[520px] overflow-hidden rounded-2xl border border-border bg-surface text-fg shadow-xl">
                <div className="border-b border-border p-5 sm:p-6">
                    <h3 className="text-center text-lg font-extrabold text-fg sm:text-xl">
                        {title}
                    </h3>
                </div>

                <div className="p-5 sm:p-6">
                    <p className="text-center text-sm text-fg-muted sm:text-base">
                        {message}
                    </p>

                    <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <button
                            type="button"
                            onClick={onCancel}
                            disabled={loading}
                            className="w-full cursor-pointer rounded-xl border border-border bg-surface px-4 py-2 font-semibold text-fg transition hover:bg-surface-2 disabled:opacity-60"
                        >
                            {cancelText}
                        </button>

                        <button
                            type="button"
                            onClick={onConfirm}
                            disabled={loading}
                            className={`w-full cursor-pointer rounded-xl px-4 py-2 font-extrabold shadow-sm transition hover:opacity-90 disabled:opacity-60 ${danger
                                    ? "bg-danger text-danger-fg"
                                    : "bg-accent text-accent-fg"
                                }`}
                        >
                            {loading ? "Eliminando..." : confirmText}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
