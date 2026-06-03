// src/features/ventaRapida/ui/AddProductoCard.tsx
import React from "react";

export default function AddProductoCard({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="
        rounded-xl border border-black/10 bg-white hover:bg-black/5 transition
        p-2.5 sm:p-3
        text-left flex flex-col
      "
    >
      <div className="w-full h-24 sm:h-28 rounded-lg border border-black/5 bg-white flex items-center justify-center">
        <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-full bg-black/10 flex items-center justify-center">
          <span className="text-2xl sm:text-3xl leading-none text-black/70 font-bold">+</span>
        </div>
      </div>

      <p className="mt-2 font-bold text-negro text-sm sm:text-base">Añadir producto</p>
    </button>
  );
}
