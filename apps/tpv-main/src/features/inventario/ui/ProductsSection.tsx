// components/inventario/ProductsSection.tsx
import Product from "../Product";
import type { ProductoDisplay } from "../hooks/useInventario";

export default function ProductsSection({
    loading,
    productos,
    onOpenDetail,
}: {
    loading: boolean;
    productos: ProductoDisplay[];
    onOpenDetail: (id: string) => void;
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
                <div className="grid grid-cols-[repeat(auto-fill,minmax(105px,1fr))] items-start gap-2 sm:grid-cols-[repeat(auto-fill,minmax(180px,1fr))] sm:gap-3 xl:grid-cols-[repeat(auto-fill,minmax(200px,1fr))]">
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
