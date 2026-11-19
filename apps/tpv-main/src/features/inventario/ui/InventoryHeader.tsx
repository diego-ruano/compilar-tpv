// components/inventario/InventoryHeader.tsx
import React from "react";
import { usePermisos } from "../../../shared/lib/usePermisos";
import { Package, ArrowLeft, Plus, FolderPlus, Salad, Trash2 } from "lucide-react";

export default function InventoryHeader({
    titulo,
    categoriaSeleccionada,
    onBack,
    onNewCategory,
    onNewProduct,
    onIngredientes,
    onDeleteCategory,
}: {
    titulo: string;
    categoriaSeleccionada: any | null;
    onBack: () => void;
    onNewCategory: () => void;
    onNewProduct: () => void;
    /** Abre la lista de ingredientes (por categorías). */
    onIngredientes: () => void;
    /** Pide confirmación para borrar la categoría abierta. */
    onDeleteCategory: () => void;
}) {
    const { puede } = usePermisos();
    return (
        // En el teléfono el título va en su línea y los dos botones debajo, a medias y con su texto: en una
        // sola línea no cabían y se quedaban sólo los iconos.
        <div className="flex w-full flex-col gap-3 rounded-2xl border border-border bg-surface p-2.5 shadow-sm sm:gap-4 sm:p-4">
            <div className="flex flex-col items-stretch gap-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                {/* Izquierda: chip + título (lista) o volver + nombre categoría (detalle) */}
                {!categoriaSeleccionada ? (
                    <div className="flex min-w-0 items-center gap-3">
                        <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent sm:size-11 sm:rounded-2xl">
                            <Package className="size-5 sm:size-6" aria-hidden />
                        </div>
                        <div className="min-w-0">
                            <h2 className="truncate text-lg font-bold text-fg max-sm:leading-tight sm:text-2xl">{titulo}</h2>
                            <p className="text-sm text-fg-muted">Gestiona tus categorías</p>
                        </div>
                    </div>
                ) : (
                    <button
                        type="button"
                        onClick={onBack}
                        className="inline-flex min-w-0 cursor-pointer items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-sm font-semibold text-fg transition hover:bg-surface-2 sm:shrink"
                    >
                        <ArrowLeft className="size-4 shrink-0" aria-hidden />
                        <span className="truncate">{titulo}</span>
                    </button>
                )}

                {/* Derecha: acción */}
                {!categoriaSeleccionada ? (
                    <div className="grid w-full shrink-0 grid-cols-2 gap-2 sm:flex sm:w-auto">
                        <button
                            type="button"
                            onClick={onIngredientes}
                            className="inline-flex flex-1 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-border bg-surface px-3 py-2 text-sm font-semibold text-fg shadow-sm transition hover:bg-surface-2 active:scale-[0.98] sm:flex-none"
                        >
                            <Salad className="size-4" aria-hidden />
                            <span className="truncate">Ingredientes</span>
                        </button>
                        <button
                            type="button"
                            disabled={!puede("catalogo.editar")}
                            // INV-MEJ-01: desactivado se veía igual que activo y no decía por qué.
                            title={puede("catalogo.editar") ? undefined : "No tienes permiso para crear categorías"}
                            onClick={onNewCategory}
                            className="inline-flex flex-1 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-sm font-semibold text-accent-fg shadow-sm transition hover:bg-accent-hover active:scale-[0.98] disabled:cursor-not-allowed sm:flex-none"
                        >
                            <FolderPlus className="size-4" aria-hidden />
                            <span className="truncate">Nueva categoría</span>
                        </button>
                    </div>
                ) : (
                    <div className="grid w-full shrink-0 grid-cols-2 gap-2 sm:flex sm:w-auto">
                        <button
                            type="button"
                            disabled={!puede("catalogo.borrar")}
                            title={puede("catalogo.borrar") ? undefined : "No tienes permiso para eliminar categorías"}
                            onClick={onDeleteCategory}
                            aria-label="Eliminar categoría"
                            className="inline-flex flex-1 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-sm font-semibold text-danger shadow-sm transition hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed sm:flex-none"
                        >
                            <Trash2 className="size-4" aria-hidden />
                            <span className="truncate">Eliminar categoría</span>
                        </button>
                        <button
                            type="button"
                            disabled={!puede("catalogo.editar") || !puede("catalogo.precios")}
                            title={puede("catalogo.editar") && puede("catalogo.precios") ? undefined : "No tienes permiso para crear productos"}
                            onClick={onNewProduct}
                            className="inline-flex flex-1 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-sm font-semibold text-accent-fg shadow-sm transition hover:bg-accent-hover active:scale-[0.98] disabled:cursor-not-allowed sm:flex-none"
                        >
                            <Plus className="size-4" aria-hidden />
                            <span className="truncate">Nuevo producto</span>
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
