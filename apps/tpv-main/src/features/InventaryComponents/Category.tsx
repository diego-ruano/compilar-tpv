// src/features/InventaryComponents/Category.tsx
import React from "react";
import { ImageOff } from "lucide-react";
import ImageWithFallback from "../../shared/ui/ImageWithFallback";

type Props = {
  img: string;
  name: string;
  onSelect: () => void;
};

const Placeholder = (
  <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-surface-2 text-fg-subtle">
    <ImageOff className="size-6" aria-hidden />
    <span className="text-xs font-semibold">Sin imagen</span>
  </div>
);

export default function Category({ img, name, onSelect }: Props) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="group w-full max-w-[260px] text-left"
    >
      <div className="rounded-2xl border border-border bg-surface p-2.5 shadow-sm transition hover:-translate-y-0.5 hover:border-border-strong hover:shadow-md sm:p-4">
        {/* Imagen */}
        <div className="flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-xl border border-border bg-surface-2">
          <ImageWithFallback
            src={img}
            alt={name}
            className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
            fallback={Placeholder}
          />
        </div>

        {/* Nombre */}
        <p className="mt-2 line-clamp-1 text-sm font-bold text-fg sm:mt-3 sm:text-lg">
          {name}
        </p>
      </div>
    </button>
  );
}
