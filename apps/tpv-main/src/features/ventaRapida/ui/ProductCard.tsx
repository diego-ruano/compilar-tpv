// src/features/ventaRapida/ui/ProductCard.tsx
import React, { useCallback } from "react";
import { ProductoDisplay } from "../types";
import { cn } from "../utils";

export type ProductCardProps = {
  p: ProductoDisplay;
  qty: number;
  onAdd: (p: ProductoDisplay) => void;
  onRemove: (productoId: number) => void;
  onInfo: (productId: number) => void;
  formatPrice: (n: number) => string;
};

function ProductCard({ p, qty, onAdd, onRemove, onInfo, formatPrice }: ProductCardProps) {
  const handleAdd = useCallback(() => onAdd(p), [onAdd, p]);
  const handleRemove = useCallback(() => onRemove(p.ID_Producto), [onRemove, p.ID_Producto]);
  const handleInfo = useCallback(() => onInfo(p.ID_Producto), [onInfo, p.ID_Producto]);

  return (
    <div className="rounded-xl border border-black/10 bg-white p-2.5 sm:p-3 text-left">
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
        className="w-full text-left hover:opacity-95 transition cursor-pointer select-none"
      >
        <div className="relative">
          <img
            src={p.urlImagen}
            alt={p.Nombre}
            loading="lazy"
            className="w-full h-24 sm:h-28 object-cover rounded-lg border border-black/5"
            draggable={false}
          />

          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              handleInfo();
            }}
            className="absolute top-2 right-2 w-8 h-8 rounded-full bg-white/90 border border-black/10 shadow-sm flex items-center justify-center text-black/70 hover:bg-white transition"
            title="Info"
            aria-label="Información del producto"
          >
            ℹ️
          </button>
        </div>

        <div className="mt-2 flex items-start justify-between gap-2 min-w-0">
          <p className="font-semibold leading-tight text-sm sm:text-base min-w-0 truncate">
            {p.Nombre}
          </p>
          <span className="text-xs sm:text-sm font-bold whitespace-nowrap">
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
            "w-10 h-10 sm:w-11 sm:h-11 rounded-xl border border-black/10 bg-white hover:bg-black/5 font-bold",
            qty === 0 && "opacity-40 cursor-not-allowed",
          )}
          disabled={qty === 0}
        >
          −
        </button>

        <div className="flex-1 text-center rounded-xl border border-black/10 bg-black/5 py-2">
          <p className="text-xs text-black/60">Cantidad</p>
          <p className="text-base sm:text-lg font-bold">{qty}</p>
        </div>

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            handleAdd();
          }}
          className="w-10 h-10 sm:w-11 sm:h-11 rounded-xl border border-black/10 bg-white hover:bg-black/5 font-bold"
        >
          +
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