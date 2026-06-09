import React from "react";

type ClienteCardProps = {
  nombre: string;
  apellido: string;
  onClick: () => void;
};

function getInitials(nombre: string, apellido: string) {
  const n = nombre?.trim()?.[0] ?? "";
  const a = apellido?.trim()?.[0] ?? "";
  return `${n}${a}`.toUpperCase() || "—";
}

export default function ClienteCard({ nombre, apellido, onClick }: ClienteCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="
        group
        w-full
        rounded-2xl
        border border-border
        bg-surface
        p-3 sm:p-4
        text-left
        shadow-sm
        transition-all duration-200
        hover:-translate-y-[1px]
        hover:border-border-strong
        hover:shadow-md
        active:translate-y-0
        focus:outline-none
        focus-visible:ring-2 focus-visible:ring-ring
      "
    >
      <div className="flex items-start gap-3">
        {/* Avatar */}
        <div
          className="
            h-9 w-9 sm:h-11 sm:w-11
            rounded-full
            bg-gradient-to-br from-accent to-accent-hover
            flex items-center justify-center
            text-accent-fg font-bold
            text-xs sm:text-sm
            shrink-0
            shadow-sm
          "
        >
          {getInitials(nombre, apellido)}
        </div>

        <div className="min-w-0 flex-1">
          <p className="font-bold text-[15px] sm:text-[17px] text-fg truncate">
            {nombre || "—"}
          </p>
          <p className="text-fg-muted font-semibold text-xs sm:text-sm truncate">
            {apellido || "—"}
          </p>

          <div className="mt-2 sm:mt-3 flex items-center justify-between">
            <span className="text-[11px] sm:text-xs text-fg-subtle">
              Ver detalles
            </span>

            <span className="text-fg-muted text-xs sm:text-sm transition-transform duration-200 group-hover:translate-x-0.5">
              →
            </span>
          </div>
        </div>
      </div>
    </button>
  );
}
