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
        <div className="bg-blanco rounded-2xl p-3 sm:p-4 shadow-xs border border-black/5">
            <div className="grid gap-4 sm:gap-5 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 place-items-start">
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
                <p className="text-center text-negro/60 py-8">
                    Aún no hay categorías. Crea la primera.
                </p>
            )}
        </div>
    );
}
