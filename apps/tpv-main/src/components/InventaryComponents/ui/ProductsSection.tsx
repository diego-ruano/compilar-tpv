// components/inventario/ProductsSection.tsx
import React from "react";
import Product from "../Product";
import type { ProductoDisplay } from "../hooks/useInventario";

export default function ProductsSection({
    loading,
    productos,
    onOpenDetail,
}: {
    loading: boolean;
    productos: ProductoDisplay[];
    onOpenDetail: (id: number) => void;
}) {
    return (
        <div className="w-full bg-blanco rounded-2xl p-3 sm:p-4 shadow-xs border border-black/5">
            {loading ? (
                <p className="text-center py-6">Cargando productos...</p>
            ) : productos.length === 0 ? (
                <p className="text-center py-6 text-negro/60">
                    No hay productos en esta categoría.
                </p>
            ) : (
                <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(160px,220px))] items-start justify-start">
                    {productos.map((p) => (
                        <Product
                            key={p.ID_Producto}
                            img={p.urlImagen}
                            name={p.Nombre}
                            onSelect={() => onOpenDetail(p.ID_Producto)}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}
