// src/features/inventario/Product.tsx
import React from "react";
import { ChevronRight, ImageOff } from "lucide-react";
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

export default function Product({ img, name, onSelect }: Props) {
  return (
    <button type="button" onClick={onSelect} className="group block w-full text-left">
      <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm transition-all duration-200 group-hover:-translate-y-0.5 group-hover:border-border-strong group-hover:shadow-md">
        <div className="relative flex aspect-[4/3] w-full items-center justify-center overflow-hidden bg-surface-2">
          <ImageWithFallback
            src={img}
            alt={name}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
            fallback={Placeholder}
          />
        </div>

        <div className="flex flex-col gap-2 p-2.5 sm:p-4">
          <h5 className="line-clamp-2 text-base font-bold text-fg sm:text-lg">{name}</h5>

          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-fg-muted sm:text-sm">Ver detalles</p>

            <span className="inline-flex size-8 items-center justify-center rounded-xl border border-border text-fg-muted transition-all duration-200 group-hover:border-accent group-hover:bg-accent group-hover:text-accent-fg sm:size-9">
              <ChevronRight className="size-5" aria-hidden />
            </span>
          </div>
        </div>
      </div>
    </button>
  );
}
