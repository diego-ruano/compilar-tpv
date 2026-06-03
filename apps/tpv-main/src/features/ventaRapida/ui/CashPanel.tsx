// src/features/ventaRapida/ui/CashPanel.tsx
import React from "react";
import { Denom } from "../types";
import { cn } from "../utils";

export default function CashPanel({
  denoms,
  cashCount,
  totalACobrar,
  totalEfectivo,
  diferencia,
  formatMoney,
  onAddCash,
  onRemoveCash,
  onReset,
  onConfirm,
  onCancel,
}: {
  denoms: Denom[];
  cashCount: Record<string, number>;
  totalACobrar: number;
  totalEfectivo: number;
  diferencia: number;
  formatMoney: (n: number) => string;
  onAddCash: (label: string) => void;
  onRemoveCash: (label: string) => void;
  onReset: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 sm:gap-4">
      <div className="rounded-xl border border-black/10 bg-white p-3 sm:p-4">
        <div className="flex items-center justify-between">
          <p className="text-xs sm:text-sm text-black/60">Total a cobrar</p>
          <p className="text-lg sm:text-xl font-bold">{formatMoney(totalACobrar)}</p>
        </div>

        <div className="mt-2 flex items-center justify-between">
          <p className="text-xs sm:text-sm text-black/60">Te han dado</p>
          <p className="text-lg sm:text-xl font-bold">{formatMoney(totalEfectivo)}</p>
        </div>

        <div className="mt-3 rounded-xl p-3 border border-black/10 bg-black/5">
          {diferencia >= 0 ? (
            <div className="flex items-center justify-between">
              <p className="text-xs sm:text-sm font-semibold text-emerald-700">Cambio</p>
              <p className="text-base sm:text-lg font-bold text-emerald-700">{formatMoney(diferencia)}</p>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <p className="text-xs sm:text-sm font-semibold text-rose-700">Falta</p>
              <p className="text-base sm:text-lg font-bold text-rose-700">{formatMoney(Math.abs(diferencia))}</p>
            </div>
          )}
        </div>

        <div className="mt-3 flex flex-col sm:flex-row gap-2">
          <button
            className="flex-1 px-3 py-2.5 sm:py-3 rounded-xl border border-black/10 bg-white hover:bg-black/5 text-sm font-semibold"
            onClick={onReset}
            type="button"
          >
            Reset
          </button>

          <button
            className={cn(
              "flex-1 px-3 py-2.5 sm:py-3 rounded-xl text-sm font-semibold transition",
              diferencia >= 0 ? "bg-black text-white hover:bg-black/90" : "bg-black/10 text-black/40 cursor-not-allowed",
            )}
            disabled={diferencia < 0}
            onClick={onConfirm}
            type="button"
            title={diferencia < 0 ? "Falta dinero" : "Confirmar cobro en efectivo"}
          >
            Confirmar cobro
          </button>

          <button
            className="flex-1 px-3 py-2.5 sm:py-3 rounded-xl border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 text-sm font-semibold"
            onClick={onCancel}
            type="button"
          >
            Cancelar
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 sm:gap-3">
        {denoms.map((d) => {
          const count = cashCount[d.label] || 0;
          return (
            <div key={d.label} className="rounded-xl border border-black/10 bg-white p-2.5 sm:p-3 flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <p className="font-bold text-sm sm:text-base">{d.label}</p>
                <span className="text-[11px] sm:text-xs text-black/50">{formatMoney(d.value)}</span>
              </div>

              <div className="flex items-center justify-between gap-2">
                <button
                  className={cn(
                    "w-10 h-10 rounded-xl border border-black/10 bg-white hover:bg-black/5 font-bold",
                    count === 0 && "opacity-40 cursor-not-allowed",
                  )}
                  disabled={count === 0}
                  onClick={() => onRemoveCash(d.label)}
                  type="button"
                >
                  −
                </button>

                <div className="flex-1 text-center">
                  <p className="text-[11px] sm:text-xs text-black/50">Cantidad</p>
                  <p className="text-base sm:text-lg font-bold">{count}</p>
                </div>

                <button
                  className="w-10 h-10 rounded-xl border border-black/10 bg-white hover:bg-black/5 font-bold"
                  onClick={() => onAddCash(d.label)}
                  type="button"
                >
                  +
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
