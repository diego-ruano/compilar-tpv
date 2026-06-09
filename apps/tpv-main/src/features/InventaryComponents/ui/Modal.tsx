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
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3"
            onMouseDown={(e) => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <div
                className={`relative w-full ${maxWidthClass} rounded-2xl border border-border bg-surface text-fg shadow-xl`}
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
                    <div className="border-b border-border px-5 pt-5 pb-3">
                        <h2 className="text-center text-lg font-extrabold text-fg">{title}</h2>
                    </div>
                )}

                <div className="p-5">{children}</div>
            </div>
        </div>
    );
}
