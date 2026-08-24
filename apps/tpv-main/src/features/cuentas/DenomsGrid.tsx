// src/features/cuentas/DenomsGrid.tsx
//
// El contador de monedas y billetes. Vivia dentro de la pantalla de Cuentas, como parte de la
// "Entrada de Caja"; ahora es el paso "cuenta el cajon" del cierre (CUENTA-06) y por eso sale a su
// propio fichero. Un solo contador y un solo sitio donde contar: dos habrian acabado dando dos
// cifras distintas del mismo dinero.

import React from "react";
import { Minus, Plus } from "lucide-react";

import { cn } from "../../shared/lib/cn";
import { euro, moneyLabel } from "./formato";
import type { CashCount, Denom } from "./cuentasApis";

function Badge({ children }: { children: React.ReactNode }) {
    return (
        <span className="inline-flex items-center rounded-full border border-border bg-surface px-2.5 py-0.5 text-xs font-medium text-fg-muted">
            {children}
        </span>
    );
}

export default function DenomsGrid({
    title,
    subtitle,
    denoms,
    count,
    onAdd,
    onRemove,
    onReset,
    total,
}: {
    title: string;
    subtitle?: string;
    denoms: Denom[];
    count: CashCount;
    onAdd: (label: string) => void;
    onRemove: (label: string) => void;
    onReset: () => void;
    total: number;
}) {
    return (
        <div className="min-w-0 rounded-2xl border border-border bg-surface p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-base font-bold text-fg sm:text-lg">
                            {title}
                        </h3>
                        <Badge>Total: {euro(total)}</Badge>
                    </div>
                    {subtitle ? (
                        <p className="mt-1 text-sm text-fg-muted">{subtitle}</p>
                    ) : null}
                </div>

                <button
                    type="button"
                    onClick={onReset}
                    className="h-8 shrink-0 rounded-lg border border-border bg-surface px-3 text-xs font-semibold text-fg transition hover:bg-surface-2 active:scale-[0.98]"
                >
                    Reset
                </button>
            </div>

            <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(135px,1fr))] gap-2.5">
                {denoms.map((d) => {
                    const c = count[d.label] || 0;
                    const active = c > 0;
                    const subtotal = Math.round(c * d.value * 100) / 100;
                    return (
                        <div
                            key={d.label}
                            className={cn(
                                "min-w-0 rounded-xl border p-3 transition-colors",
                                active
                                    ? "border-accent bg-accent-soft ring-1 ring-accent/30"
                                    : "border-border bg-surface-2",
                            )}
                        >
                            <div className="flex items-center justify-between gap-2">
                                <p className="truncate text-base font-extrabold text-fg">
                                    {d.label}
                                </p>
                                {active ? (
                                    <span className="grid min-w-5 place-items-center rounded-full bg-accent px-1.5 text-[11px] font-bold text-accent-fg">
                                        {c}
                                    </span>
                                ) : (
                                    <span className="text-xs text-fg-subtle">{moneyLabel(d.value)}</span>
                                )}
                            </div>

                            <p className="mt-0.5 truncate text-[11px] text-fg-muted">
                                {active ? `Subtotal ${euro(subtotal)}` : moneyLabel(d.value)}
                            </p>

                            <div className="mt-3 grid grid-cols-[2rem_minmax(1.5rem,1fr)_2rem] items-center gap-1.5">
                                <button
                                    type="button"
                                    onClick={() => onRemove(d.label)}
                                    disabled={c === 0}
                                    aria-label={`Quitar ${d.label}`}
                                    className={cn(
                                        "grid size-8 place-items-center rounded-lg border border-border bg-surface text-fg transition hover:bg-surface-2 active:scale-[0.95] cursor-pointer",
                                        c === 0 && "cursor-not-allowed opacity-40",
                                    )}
                                >
                                    <Minus className="size-4" aria-hidden />
                                </button>

                                <div className="min-w-0 text-center">
                                    <p className="truncate text-lg font-extrabold leading-none text-fg">
                                        {c}
                                    </p>
                                </div>

                                <button
                                    type="button"
                                    onClick={() => onAdd(d.label)}
                                    aria-label={`Añadir ${d.label}`}
                                    className="grid size-8 place-items-center rounded-lg bg-accent text-accent-fg shadow-sm transition hover:bg-accent-hover active:scale-[0.95] cursor-pointer"
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
