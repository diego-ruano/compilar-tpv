// src/features/ventaRapida/ui/CategoryCard.tsx
import React from "react";
import { ImageOff } from "lucide-react";
import { CategoriaDisplay } from "../types";
import ImageWithFallback from "../../../shared/ui/ImageWithFallback";

export type CategoryCardProps = {
  c: CategoriaDisplay;
  onSelect: (c: CategoriaDisplay) => void;
};

const Placeholder = (
  <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-surface-2 text-fg-subtle">
    <ImageOff className="size-6" aria-hidden />
    <span className="text-[11px] font-semibold sm:text-xs">Sin imagen</span>
  </div>
);

function CategoryCard({ c, onSelect }: CategoryCardProps) {
  return (
    <button
      onClick={() => onSelect(c)}
      className="
        group min-w-0 rounded-2xl border border-border bg-surface p-2 text-left shadow-sm
        transition hover:border-border-strong hover:bg-surface-2 active:scale-[0.99]
        cursor-pointer sm:p-3
      "
      type="button"
      title={c.Nombre}
    >
      <div className="flex h-20 w-full items-center justify-center overflow-hidden rounded-xl border border-border bg-surface-2 sm:h-28">
        <ImageWithFallback
          src={c.urlImagen}
          alt={c.Nombre}
          className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
          fallback={Placeholder}
        />
      </div>

      <p className="mt-1.5 truncate text-xs font-bold text-fg sm:mt-2 sm:text-base">{c.Nombre}</p>
    </button>
  );
}

export default React.memo(CategoryCard);
