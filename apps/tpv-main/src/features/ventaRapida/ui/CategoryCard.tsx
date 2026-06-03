// src/features/ventaRapida/ui/CategoryCard.tsx
import React, { useEffect, useState } from "react";
import { CategoriaDisplay } from "../types";

export type CategoryCardProps = {
  c: CategoriaDisplay;
  onSelect: (c: CategoriaDisplay) => void;
};

function CategoryCard({ c, onSelect }: CategoryCardProps) {
  const [imgOk, setImgOk] = useState(Boolean(c.urlImagen));

  useEffect(() => {
    setImgOk(Boolean(c.urlImagen));
  }, [c.urlImagen]);

  return (
    <button
      onClick={() => onSelect(c)}
      className="
        rounded-xl border border-black/10 bg-white hover:bg-black/5 transition
        p-2.5 sm:p-3
        text-left
      "
      type="button"
      title={c.Nombre}
    >
      <div className="w-full h-24 sm:h-28 rounded-lg border border-black/5 bg-black/[0.03] overflow-hidden flex items-center justify-center">
        {imgOk ? (
          <img
            src={c.urlImagen}
            alt={c.Nombre}
            loading="lazy"
            className="w-full h-full object-cover"
            onError={() => setImgOk(false)}
            draggable={false}
          />
        ) : (
          <div className="text-xs text-black/50 font-semibold px-2 text-center">Sin imagen</div>
        )}
      </div>

      <p className="mt-2 font-bold truncate text-sm sm:text-base">{c.Nombre}</p>
    </button>
  );
}

export default React.memo(CategoryCard);
