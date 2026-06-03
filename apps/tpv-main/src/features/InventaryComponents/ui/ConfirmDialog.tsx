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
            <div className="bg-blanco w-full max-w-[520px] rounded-2xl shadow-xl border border-black/10 overflow-hidden">
                <div className="p-5 sm:p-6 border-b border-black/10">
                    <h3 className="text-lg sm:text-xl font-extrabold text-negro text-center">
                        {title}
                    </h3>
                </div>

                <div className="p-5 sm:p-6">
                    <p className="text-sm sm:text-base text-negro/80 text-center">
                        {message}
                    </p>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-5">
                        <button
                            type="button"
                            onClick={onCancel}
                            disabled={loading}
                            className="w-full px-4 py-2 rounded-xl border border-negro/20 hover:bg-gris transition font-semibold disabled:opacity-60"
                        >
                            {cancelText}
                        </button>

                        <button
                            type="button"
                            onClick={onConfirm}
                            disabled={loading}
                            className={`w-full px-4 py-2 rounded-xl font-extrabold transition disabled:opacity-60 ${danger
                                    ? "border border-rojo text-white bg-rojo hover:opacity-90"
                                    : "bg-verde text-white hover:opacity-90"
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
