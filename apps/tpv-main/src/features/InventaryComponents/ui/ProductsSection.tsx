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
        <div className="w-full rounded-2xl border border-border bg-surface p-3 shadow-sm sm:p-4">
            {loading ? (
                <p className="py-6 text-center text-fg-muted">Cargando productos...</p>
            ) : productos.length === 0 ? (
                <p className="py-6 text-center text-fg-muted">
                    No hay productos en esta categoría.
                </p>
            ) : (
                <div className="grid items-start justify-start gap-3 [grid-template-columns:repeat(auto-fit,minmax(160px,220px))]">
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
