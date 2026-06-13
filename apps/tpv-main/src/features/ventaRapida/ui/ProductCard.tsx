// src/features/ventaRapida/ui/ProductCard.tsx
import React, { useCallback } from "react";
import { Info, Minus, Plus, ImageOff } from "lucide-react";
import { ProductoDisplay } from "../types";
import { cn } from "../utils";

export type ProductCardProps = {
  p: ProductoDisplay;
  qty: number;
  onAdd: (p: ProductoDisplay) => void;
  onRemove: (productoId: string) => void;
  onInfo: (productId: string) => void;
  formatPrice: (n: number) => string;
};

function ProductCard({ p, qty, onAdd, onRemove, onInfo, formatPrice }: ProductCardProps) {
  const handleAdd = useCallback(() => onAdd(p), [onAdd, p]);
  const handleRemove = useCallback(() => onRemove(p.ID_Producto), [onRemove, p.ID_Producto]);
  const handleInfo = useCallback(() => onInfo(p.ID_Producto), [onInfo, p.ID_Producto]);

  const hasQty = qty > 0;

  return (
    <div
      className={cn(
        "rounded-2xl border bg-surface p-2.5 text-left shadow-sm transition sm:p-3",
        hasQty ? "border-accent ring-1 ring-accent/30" : "border-border",
      )}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={handleAdd}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleAdd();
          }
        }}
        className="w-full cursor-pointer select-none text-left transition hover:opacity-95"
      >
        <div className="relative">
          {p.urlImagen ? (
            <img
              src={p.urlImagen}
              alt={p.Nombre}
              loading="lazy"
              className="h-24 w-full rounded-xl border border-border object-cover sm:h-28"
              draggable={false}
            />
          ) : (
            <div className="flex h-24 w-full items-center justify-center rounded-xl border border-border bg-surface-2 text-fg-subtle sm:h-28">
              <ImageOff className="size-6" aria-hidden />
            </div>
          )}

          {hasQty && (
            <span className="absolute left-2 top-2 grid min-w-6 place-items-center rounded-full bg-accent px-1.5 py-0.5 text-xs font-bold text-accent-fg shadow-sm">
              {qty}
            </span>
          )}

          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              handleInfo();
            }}
            className="absolute right-2 top-2 grid size-8 place-items-center rounded-full border border-border bg-surface/90 text-fg-muted shadow-sm backdrop-blur transition hover:bg-surface hover:text-fg cursor-pointer"
            title="Info"
            aria-label="Información del producto"
          >
            <Info className="size-4" aria-hidden />
          </button>
        </div>

        <div className="mt-2 flex min-w-0 items-start justify-between gap-2">
          <p className="min-w-0 truncate text-sm font-semibold leading-tight text-fg sm:text-base">
            {p.Nombre}
          </p>
          <span className="whitespace-nowrap text-xs font-bold text-fg sm:text-sm">
            {formatPrice(Number(p.Precio_Venta || 0))}
          </span>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            handleRemove();
          }}
          className={cn(
            "grid size-10 place-items-center rounded-xl border border-border bg-surface text-fg transition hover:bg-surface-2 sm:size-11 cursor-pointer",
            qty === 0 && "cursor-not-allowed opacity-40",
          )}
          disabled={qty === 0}
          aria-label="Quitar uno"
        >
          <Minus className="size-4" aria-hidden />
        </button>

        <div className="flex-1 rounded-xl border border-border bg-surface-2 py-1.5 text-center">
          <p className="text-[11px] text-fg-subtle">Cantidad</p>
          <p className="text-base font-bold text-fg sm:text-lg">{qty}</p>
        </div>

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            handleAdd();
          }}
          className="grid size-10 place-items-center rounded-xl bg-accent text-accent-fg shadow-sm transition hover:bg-accent-hover sm:size-11 cursor-pointer"
          aria-label="Añadir uno"
        >
          <Plus className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}

export default React.memo(ProductCard, (prev, next) => {
  return (
    prev.qty === next.qty &&
    prev.p.ID_Producto === next.p.ID_Producto &&
    prev.p.Nombre === next.p.Nombre &&
    Number(prev.p.Precio_Venta || 0) === Number(next.p.Precio_Venta || 0) &&
    prev.p.urlImagen === next.p.urlImagen &&
    prev.onAdd === next.onAdd &&
    prev.onRemove === next.onRemove &&
    prev.onInfo === next.onInfo &&
    prev.formatPrice === next.formatPrice
  );
});
