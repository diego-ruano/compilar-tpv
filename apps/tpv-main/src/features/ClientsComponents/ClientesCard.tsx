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
        border border-negro/10
        bg-white
        p-3 sm:p-4
        text-left
        shadow-sm
        transition-all duration-200
        hover:-translate-y-[1px]
        hover:shadow-md
        hover:border-negro/20
        active:translate-y-0
        focus:outline-none
        focus:ring-2 focus:ring-verde/40
      "
    >
      <div className="flex items-start gap-3">
        {/* Avatar */}
        <div
          className="
            h-9 w-9 sm:h-11 sm:w-11
            rounded-full
            bg-gradient-to-br from-morado/80 to-morado
            flex items-center justify-center
            text-white font-bold
            text-xs sm:text-sm
            shrink-0
            shadow-sm
          "
        >
          {getInitials(nombre, apellido)}
        </div>

        <div className="min-w-0 flex-1">
          <p className="font-bold text-[15px] sm:text-[17px] text-negro truncate">
            {nombre || "—"}
          </p>
          <p className="text-negro/60 font-semibold text-xs sm:text-sm truncate">
            {apellido || "—"}
          </p>

          <div className="mt-2 sm:mt-3 flex items-center justify-between">
            <span className="text-[11px] sm:text-xs text-negro/55">
              Ver detalles
            </span>

            <span className="text-negro/60 text-xs sm:text-sm transition-transform duration-200 group-hover:translate-x-0.5">
              →
            </span>
          </div>
        </div>
      </div>
    </button>
  );
}
