// components/ui/Modal.tsx
import React from "react";

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
            className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-3"
            onMouseDown={(e) => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <div
                className={`bg-blanco w-full ${maxWidthClass} rounded-2xl shadow-xl border border-black/10 relative`}
            >
                <button
                    type="button"
                    onClick={onClose}
                    className="absolute top-3 right-3 px-3 py-1 rounded-xl border border-negro/20 hover:bg-gris transition"
                >
                    ✕
                </button>

                {title && (
                    <div className="px-5 pt-5 pb-3 border-b border-black/10">
                        <h2 className="text-lg font-extrabold text-center">{title}</h2>
                    </div>
                )}

                <div className="p-5">{children}</div>
            </div>
        </div>
    );
}
