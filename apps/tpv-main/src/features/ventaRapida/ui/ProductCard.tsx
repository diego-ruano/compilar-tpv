// src/features/ventaRapida/ui/ProductCard.tsx
import React, { useCallback } from "react";
import { Info, Minus, Plus, ImageOff } from "lucide-react";
import { ProductoDisplay } from "../types";
import { cn } from "../utils";
import ImageWithFallback from "../../../shared/ui/ImageWithFallback";
import { eur } from "../../../shared/lib/dinero";

export type ProductCardProps = {
  p: ProductoDisplay;
  qty: number;
  onAdd: (p: ProductoDisplay) => void;
  onRemove: (productoId: string) => void;
  onInfo: (productId: string) => void;
};

function ProductCard({ p, qty, onAdd, onRemove, onInfo }: ProductCardProps) {
  const handleAdd = useCallback(() => onAdd(p), [onAdd, p]);
  const handleRemove = useCallback(() => onRemove(p.ID_Producto), [onRemove, p.ID_Producto]);
  const handleInfo = useCallback(() => onInfo(p.ID_Producto), [onInfo, p.ID_Producto]);

  const hasQty = qty > 0;

  return (
    <div
      className={cn(
        "min-w-0 rounded-2xl border bg-surface p-2 text-left shadow-sm transition sm:p-3",
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
          <ImageWithFallback
            src={p.urlImagen}
            alt={p.Nombre}
            className="h-20 w-full rounded-xl border border-border object-cover sm:h-28"
            fallback={
              <div className="flex h-20 w-full items-center justify-center rounded-xl border border-border bg-surface-2 text-fg-subtle sm:h-28">
                <ImageOff className="size-6" aria-hidden />
              </div>
            }
          />

          {hasQty && (
            <span className="absolute left-1.5 top-1.5 grid sm:left-2 sm:top-2 min-w-6 place-items-center rounded-full bg-accent px-1.5 py-0.5 text-xs font-bold text-accent-fg shadow-sm">
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
            className="absolute right-1.5 top-1.5 grid size-7 place-items-center sm:right-2 sm:top-2 sm:size-8 rounded-full border border-border bg-surface/90 text-fg-muted shadow-sm backdrop-blur transition hover:bg-surface hover:text-fg cursor-pointer"
            title="Info"
            aria-label="Información del producto"
          >
            <Info className="size-4" aria-hidden />
          </button>
        </div>

        {/* En el teléfono el precio va debajo del nombre: en tres columnas no caben juntos. */}
        <div className="mt-1.5 flex min-w-0 flex-col gap-0.5 sm:mt-2 sm:flex-row sm:items-start sm:justify-between sm:gap-2">
          <p className="min-w-0 truncate text-xs font-semibold leading-tight text-fg sm:text-base">
            {p.Nombre}
          </p>
          <span className="whitespace-nowrap text-xs font-bold text-fg sm:text-sm">
            {eur(p.Precio_Venta)}
          </span>
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between gap-1 sm:mt-3 sm:gap-2">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            handleRemove();
          }}
          className={cn(
            "grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-surface text-fg transition hover:bg-surface-2 sm:size-11 sm:rounded-xl cursor-pointer",
            qty === 0 && "cursor-not-allowed opacity-40",
          )}
          disabled={qty === 0}
          aria-label="Quitar uno"
        >
          <Minus className="size-4" aria-hidden />
        </button>

        <div className="min-w-0 flex-1 rounded-lg border border-border bg-surface-2 py-1 text-center sm:rounded-xl sm:py-1.5">
          <p className="hidden text-[11px] text-fg-subtle sm:block">Cantidad</p>
          <p className="text-sm font-bold text-fg sm:text-lg">{qty}</p>
        </div>

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            handleAdd();
          }}
          className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent text-accent-fg shadow-sm transition hover:bg-accent-hover sm:size-11 sm:rounded-xl cursor-pointer"
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
    prev.p.Precio_Venta === next.p.Precio_Venta &&
    prev.p.urlImagen === next.p.urlImagen &&
    prev.onAdd === next.onAdd &&
    prev.onRemove === next.onRemove &&
    prev.onInfo === next.onInfo
  );
});
