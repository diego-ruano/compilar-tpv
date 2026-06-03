import React from "react";

function ListClients({
  children,
  title,
}: {
  children: React.ReactNode;
  title: string;
}) {
  return (
    <div className="bg-blanco w-full p-4 rounded-xl shadow-xs">
      <h3 className="font-xl font-bold text-center mb-4">{title}</h3>

      <div className="flex flex-col gap-2">{children || "No hay productos"}</div>

      <div
        className="
          w-full flex justify-center mt-4 gap-2
          flex-nowrap
        "
      >
        <button
          className="
            border-2 border-morado text-morado cursor-pointer
            transition-all duration-300 ease-in-out
            hover:bg-morado hover:text-white
            whitespace-nowrap shrink-0
            rounded-lg px-2 py-1 text-[11px]
            sm:rounded-xl sm:px-3 sm:py-1 sm:text-sm
          "
        >
          Cargar Más
        </button>

        <button
          className="
            border-2 border-azul text-azul cursor-pointer
            transition-all duration-300 ease-in-out
            hover:bg-azul hover:text-white
            whitespace-nowrap shrink-0
            rounded-lg px-2 py-1 text-[11px]
            sm:rounded-xl sm:px-3 sm:py-1 sm:text-sm
          "
        >
          Enviar Publicidad
        </button>
      </div>
    </div>
  );
}

export default ListClients;
