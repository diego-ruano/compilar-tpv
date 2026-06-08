// src/features/ventaRapida/ui/CashPanel.tsx
import React from "react";
import { Minus, Plus, RotateCcw } from "lucide-react";
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
      <div className="rounded-2xl border border-border bg-surface p-3 sm:p-4">
        <div className="flex items-center justify-between">
          <p className="text-xs text-fg-muted sm:text-sm">Total a cobrar</p>
          <p className="text-lg font-bold text-fg sm:text-xl">{formatMoney(totalACobrar)}</p>
        </div>

        <div className="mt-2 flex items-center justify-between">
          <p className="text-xs text-fg-muted sm:text-sm">Te han dado</p>
          <p className="text-lg font-bold text-fg sm:text-xl">{formatMoney(totalEfectivo)}</p>
        </div>

        <div
          className={cn(
            "mt-3 rounded-xl border p-3",
            diferencia >= 0
              ? "border-success/30 bg-success-soft"
              : "border-danger/30 bg-danger-soft",
          )}
        >
          {diferencia >= 0 ? (
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-success sm:text-sm">Cambio</p>
              <p className="text-base font-bold text-success sm:text-lg">{formatMoney(diferencia)}</p>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-danger sm:text-sm">Falta</p>
              <p className="text-base font-bold text-danger sm:text-lg">
                {formatMoney(Math.abs(diferencia))}
              </p>
            </div>
          )}
        </div>

        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <button
            className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-border bg-surface px-3 py-2.5 text-sm font-semibold text-fg transition hover:bg-surface-2 cursor-pointer sm:py-3"
            onClick={onReset}
            type="button"
          >
            <RotateCcw className="size-4" aria-hidden />
            Reset
          </button>

          <button
            className={cn(
              "flex-1 rounded-xl px-3 py-2.5 text-sm font-semibold transition active:scale-[0.98] sm:py-3",
              diferencia >= 0
                ? "bg-accent text-accent-fg shadow-sm hover:bg-accent-hover cursor-pointer"
                : "bg-surface-2 text-fg-subtle cursor-not-allowed",
            )}
            disabled={diferencia < 0}
            onClick={onConfirm}
            type="button"
            title={diferencia < 0 ? "Falta dinero" : "Confirmar cobro en efectivo"}
          >
            Confirmar cobro
          </button>

          <button
            className="flex-1 rounded-xl border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm font-semibold text-danger transition hover:opacity-90 cursor-pointer sm:py-3"
            onClick={onCancel}
            type="button"
          >
            Cancelar
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 lg:grid-cols-4">
        {denoms.map((d) => {
          const count = cashCount[d.label] || 0;
          return (
            <div
              key={d.label}
              className={cn(
                "flex flex-col gap-2 rounded-2xl border bg-surface p-2.5 transition sm:p-3",
                count > 0 ? "border-accent ring-1 ring-accent/30" : "border-border",
              )}
            >
              <div className="flex items-center justify-between">
                <p className="text-sm font-bold text-fg sm:text-base">{d.label}</p>
                <span className="text-[11px] text-fg-subtle sm:text-xs">{formatMoney(d.value)}</span>
              </div>

              <div className="flex items-center justify-between gap-2">
                <button
                  className={cn(
                    "grid size-10 place-items-center rounded-xl border border-border bg-surface text-fg transition hover:bg-surface-2 cursor-pointer",
                    count === 0 && "cursor-not-allowed opacity-40",
                  )}
                  disabled={count === 0}
                  onClick={() => onRemoveCash(d.label)}
                  type="button"
                  aria-label="Quitar uno"
                >
                  <Minus className="size-4" aria-hidden />
                </button>

                <div className="flex-1 text-center">
                  <p className="text-[11px] text-fg-subtle sm:text-xs">Cantidad</p>
                  <p className="text-base font-bold text-fg sm:text-lg">{count}</p>
                </div>

                <button
                  className="grid size-10 place-items-center rounded-xl bg-accent text-accent-fg shadow-sm transition hover:bg-accent-hover cursor-pointer"
                  onClick={() => onAddCash(d.label)}
                  type="button"
                  aria-label="Añadir uno"
                >
                  <Plus className="size-4" aria-hidden />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
