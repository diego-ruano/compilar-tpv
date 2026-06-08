// src/features/ventaRapida/ui/CategoryCard.tsx
import React, { useEffect, useState } from "react";
import { ImageOff } from "lucide-react";
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
        group rounded-2xl border border-border bg-surface p-2.5 text-left shadow-sm
        transition hover:border-border-strong hover:bg-surface-2 active:scale-[0.99]
        cursor-pointer sm:p-3
      "
      type="button"
      title={c.Nombre}
    >
      <div className="flex h-24 w-full items-center justify-center overflow-hidden rounded-xl border border-border bg-surface-2 sm:h-28">
        {imgOk ? (
          <img
            src={c.urlImagen}
            alt={c.Nombre}
            loading="lazy"
            className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
            onError={() => setImgOk(false)}
            draggable={false}
          />
        ) : (
          <div className="flex flex-col items-center gap-1 text-fg-subtle">
            <ImageOff className="size-6" aria-hidden />
            <span className="text-xs font-semibold">Sin imagen</span>
          </div>
        )}
      </div>

      <p className="mt-2 truncate text-sm font-bold text-fg sm:text-base">{c.Nombre}</p>
    </button>
  );
}

export default React.memo(CategoryCard);
