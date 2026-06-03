// src/features/InventaryComponents/Category.tsx
import React from "react";

type Props = {
  img: string;
  name: string;
  onSelect: () => void;
};

export default function Category({ img, name, onSelect }: Props) {
  const hasImg = !!img;

  return (
    <button
      type="button"
      onClick={onSelect}
      className="w-full max-w-[260px] text-left"
    >
      <div className="bg-blanco rounded-2xl border border-black/10 shadow-sm p-5 hover:shadow-md transition">
        {/* Imagen */}
        <div className="w-full aspect-[4/3] rounded-2xl overflow-hidden bg-gris border border-black/10 flex items-center justify-center">
          {hasImg ? (
            <img
              src={img}
              alt={name}
              className="w-full h-full object-cover"
              loading="lazy"
              draggable={false}
            />
          ) : (
            <div className="text-negro/50 text-sm font-semibold">Sin imagen</div>
          )}
        </div>

        {/* Nombre */}
        <p className="mt-3 text-base sm:text-lg font-bold text-negro line-clamp-1">
          {name}
        </p>
      </div>
    </button>
  );
}
