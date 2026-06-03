// src/features/ventaRapida/ui/Modal.tsx
import React from "react";

export default function Modal({
  open,
  onClose,
  children,
  title,
  maxWidthClass = "max-w-[980px]",
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
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-2 sm:p-3"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`
          bg-blanco w-full ${maxWidthClass}
          rounded-2xl shadow-xl border border-black/10 relative
          max-h-[calc(100vh-1rem)] sm:max-h-[calc(100vh-1.5rem)]
          overflow-hidden
        `}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute top-2.5 right-2.5 sm:top-3 sm:right-3 px-3 py-1 rounded-xl border border-negro/20 hover:bg-gris transition text-sm"
        >
          ✕
        </button>

        {title ? (
          <div className="px-4 sm:px-5 pt-4 sm:pt-5 pb-3 border-b border-black/10">
            <h2 className="text-base sm:text-lg font-extrabold text-center">{title}</h2>
          </div>
        ) : null}

        <div className="p-4 sm:p-5 overflow-y-auto max-h-[calc(100vh-6.5rem)]">{children}</div>
      </div>
    </div>
  );
}
