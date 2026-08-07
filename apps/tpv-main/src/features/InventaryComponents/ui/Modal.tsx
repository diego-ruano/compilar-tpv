// components/ui/Modal.tsx
import React from "react";
import { X } from "lucide-react";

export default function Modal({
    open,
    onClose,
    children,
    title,
    maxWidthClass = "max-w-[680px]",
}: {
    open: boolean;
    onClose: () => void;
    title?: string;
    maxWidthClass?: string;
    children: React.ReactNode;
}) {
    if (!open) return null;

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-2 sm:p-3"
            onMouseDown={(e) => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <div
                className={`relative flex max-h-[calc(100dvh-1rem)] w-full flex-col overflow-hidden ${maxWidthClass} rounded-2xl border border-border bg-surface text-fg shadow-xl sm:max-h-[calc(100dvh-1.5rem)]`}
            >
                <button
                    type="button"
                    onClick={onClose}
                    aria-label="Cerrar"
                    className="absolute top-3 right-3 grid size-9 place-items-center rounded-xl border border-border text-fg-muted transition hover:bg-surface-2 hover:text-fg cursor-pointer"
                >
                    <X className="size-4" aria-hidden />
                </button>

                {title && (
                    <div className="shrink-0 border-b border-border px-4 pb-3 pt-4 sm:px-5 sm:pt-5">
                        <h2 className="text-center text-lg font-extrabold text-fg">{title}</h2>
                    </div>
                )}

                <div className="min-h-0 overflow-y-auto p-3 sm:p-5">{children}</div>
            </div>
        </div>
    );
}
