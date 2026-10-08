import React from "react";

function ItemListClients({
  className,
  nombre,
  ultimaReserva,
}: {
  className?: string;
  nombre: string;
  ultimaReserva: string;
}) {
  return (
    <div
      className={`
        w-full px-4
        flex items-center gap-2
        justify-between
        ${className ?? ""}
      `}
    >
      {/* Bloque izquierdo */}
      <div className="min-w-0 flex-1">
        <p className="truncate">{nombre}</p>
      </div>

      <div className="shrink-0">
        <p className="whitespace-nowrap">{ultimaReserva}</p>
      </div>

      {/* ✅ Botonera: SIEMPRE en una sola línea */}
      <div
        className="
          flex items-center justify-center gap-2
          flex-nowrap
          overflow-x-auto
          [-ms-overflow-style:none] [scrollbar-width:none]
          [&::-webkit-scrollbar]:hidden
        "
      >
        <button
          className="
            cursor-pointer
            whitespace-nowrap shrink-0
            border-2 border-negro/20 rounded-lg
            px-2 py-1 text-[11px]
            sm:px-3 sm:py-1 sm:text-sm sm:rounded-xl
            hover:bg-negro hover:text-white transition
          "
        >
          Contacto
        </button>

        <button
          className="
            cursor-pointer
            whitespace-nowrap shrink-0
            border-2 border-negro/20 rounded-lg
            px-2 py-1 text-[11px]
            sm:px-3 sm:py-1 sm:text-sm sm:rounded-xl
            hover:bg-negro hover:text-white transition
          "
        >
          Estadísticas
        </button>

        <button
          className="
            cursor-pointer
            whitespace-nowrap shrink-0
            border-2 border-negro/20 rounded-lg
            px-2 py-1 text-[11px]
            sm:px-3 sm:py-1 sm:text-sm sm:rounded-xl
            hover:bg-negro hover:text-white transition
          "
        >
          Datos Factura
        </button>

        <button
          className="
            cursor-pointer
            whitespace-nowrap shrink-0
            border-2 border-negro/20 rounded-lg
            px-2 py-1 text-[11px]
            sm:px-3 sm:py-1 sm:text-sm sm:rounded-xl
            hover:bg-negro hover:text-white transition
          "
        >
          Editar
        </button>
      </div>
    </div>
  );
}

export default ItemListClients;
