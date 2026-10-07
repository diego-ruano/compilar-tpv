// components/inventario/InventoryHeader.tsx
import React from "react";
import { usePermisos } from "../../../shared/lib/usePermisos";
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
    const { puede } = usePermisos();
    return (
        <div className="flex w-full flex-col gap-3 rounded-2xl border border-border bg-surface p-3 shadow-sm sm:gap-4 sm:p-4">
            <div className="flex flex-col items-stretch gap-3 xs:flex-row xs:items-center xs:justify-between">
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
                        className="inline-flex min-w-0 cursor-pointer items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-sm font-semibold text-fg transition hover:bg-surface-2 xs:shrink"
                    >
                        <ArrowLeft className="size-4 shrink-0" aria-hidden />
                        <span className="truncate">{titulo}</span>
                    </button>
                )}

                {/* Derecha: acción */}
                {!categoriaSeleccionada ? (
                    <button
                        type="button"
                        disabled={!puede("catalogo.editar")}
                        onClick={onNewCategory}
                        className="inline-flex w-full shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-sm font-semibold text-accent-fg shadow-sm transition hover:bg-accent-hover active:scale-[0.98] xs:w-auto"
                    >
                        <FolderPlus className="size-4" aria-hidden />
                        <span className="hidden xs:inline">Nueva categoría</span>
                    </button>
                ) : (
                    <button
                        type="button"
                        disabled={!puede("catalogo.editar") || !puede("catalogo.precios")}
                        onClick={onNewProduct}
                        className="inline-flex w-full shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-sm font-semibold text-accent-fg shadow-sm transition hover:bg-accent-hover active:scale-[0.98] xs:w-auto"
                    >
                        <Plus className="size-4" aria-hidden />
                        <span className="hidden xs:inline">Nuevo producto</span>
                    </button>
                )}
            </div>
        </div>
    );
}
