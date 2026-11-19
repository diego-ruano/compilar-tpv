// components/inventario/CategoriesSection.tsx
import React from "react";
import Category from "../Category";
import type { CategoriaDisplay } from "../hooks/useInventario";

export default function CategoriesSection({
    categorias,
    onSelect,
}: {
    categorias: CategoriaDisplay[];
    onSelect: (c: CategoriaDisplay) => void;
}) {
    return (
        <div className="rounded-2xl border border-border bg-surface p-3 shadow-sm sm:p-4">
            <div className="grid grid-cols-[repeat(auto-fill,minmax(105px,1fr))] items-start gap-2 sm:grid-cols-[repeat(auto-fill,minmax(170px,1fr))] sm:gap-4 lg:gap-5">
                {categorias.map((item) => (
                    <Category
                        key={item.ID_Categoria}
                        img={item.urlImagen || "placeholder.webp"}
                        name={item.Nombre}
                        onSelect={() => onSelect(item)}
                    />
                ))}
            </div>

            {categorias.length === 0 && (
                <p className="py-8 text-center text-fg-muted">
                    Aún no hay categorías. Crea la primera.
                </p>
            )}
        </div>
    );
}
