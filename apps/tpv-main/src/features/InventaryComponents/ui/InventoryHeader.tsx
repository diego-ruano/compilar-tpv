// components/inventario/InventoryHeader.tsx
import React from "react";
import { Package, ArrowLeft, Plus, FolderPlus } from "lucide-react";

export default function InventoryHeader({
    titulo,
    categoriaSeleccionada,
    onBack,
    onNewCategory,
    onNewProduct,
}: {
    titulo: string;
    categoriaSeleccionada: any | null;
    onBack: () => void;
    onNewCategory: () => void;
    onNewProduct: () => void;
}) {
    return (
        <div className="flex w-full flex-col gap-4 rounded-2xl border border-border bg-surface p-4 shadow-sm">
            <div className="flex items-center justify-between gap-3">
                {/* Izquierda: chip + título (lista) o volver + nombre categoría (detalle) */}
                {!categoriaSeleccionada ? (
                    <div className="flex min-w-0 items-center gap-3">
                        <div className="grid size-11 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent">
                            <Package className="size-6" aria-hidden />
                        </div>
                        <div className="min-w-0">
                            <h2 className="truncate text-xl font-bold text-fg sm:text-2xl">{titulo}</h2>
                            <p className="text-sm text-fg-muted">Gestiona tus categorías</p>
                        </div>
                    </div>
                ) : (
                    <button
                        type="button"
                        onClick={onBack}
                        className="inline-flex min-w-0 shrink cursor-pointer items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-sm font-semibold text-fg transition hover:bg-surface-2"
                    >
                        <ArrowLeft className="size-4 shrink-0" aria-hidden />
                        <span className="truncate">{titulo}</span>
                    </button>
                )}

                {/* Derecha: acción */}
                {!categoriaSeleccionada ? (
                    <button
                        type="button"
                        onClick={onNewCategory}
                        className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-sm font-semibold text-accent-fg shadow-sm transition hover:bg-accent-hover active:scale-[0.98]"
                    >
                        <FolderPlus className="size-4" aria-hidden />
                        <span className="hidden xs:inline">Nueva categoría</span>
                    </button>
                ) : (
                    <button
                        type="button"
                        onClick={onNewProduct}
                        className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-sm font-semibold text-accent-fg shadow-sm transition hover:bg-accent-hover active:scale-[0.98]"
                    >
                        <Plus className="size-4" aria-hidden />
                        <span className="hidden xs:inline">Nuevo producto</span>
                    </button>
                )}
            </div>
        </div>
    );
}
