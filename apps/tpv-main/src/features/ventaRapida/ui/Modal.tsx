// src/features/ventaRapida/ui/Modal.tsx
import React from "react";
import { X } from "lucide-react";

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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-2 sm:p-3"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`
          relative w-full ${maxWidthClass}
          overflow-hidden rounded-2xl border border-border bg-surface text-fg shadow-xl
          max-h-[calc(100vh-1rem)] sm:max-h-[calc(100vh-1.5rem)]
        `}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Cerrar"
          className="absolute right-2.5 top-2.5 grid size-9 place-items-center rounded-xl border border-border bg-surface text-fg-muted transition hover:bg-surface-2 hover:text-fg cursor-pointer sm:right-3 sm:top-3"
        >
          <X className="size-4" aria-hidden />
        </button>

        {title ? (
          <div className="border-b border-border px-4 pb-3 pt-4 sm:px-5 sm:pt-5">
            <h2 className="text-center text-base font-extrabold text-fg sm:text-lg">{title}</h2>
          </div>
        ) : null}

        <div className="overflow-y-auto p-4 max-h-[calc(100vh-6.5rem)] sm:p-5">{children}</div>
      </div>
    </div>
  );
}
