// src/features/ventaRapida/ui/CatalogGrid.tsx
import React from "react";
import type { CategoriaDisplay, ProductoDisplay } from "../types";
import AddProductoCard from "./AddProductoCard";
import ProductCard from "./ProductCard";
import CategoryCard from "./CategoryCard";

type Variant = "search" | "categories" | "products";

type Props = {
  variant: Variant;
  loading?: boolean;

  categorias?: CategoriaDisplay[] | null;
  productos?: ProductoDisplay[] | null;
  busqueda?: ProductoDisplay[] | null;

  onOpenAddProduct: () => void;
  onSelectCategoria: (c: CategoriaDisplay) => void;

  onAddProducto: (p: ProductoDisplay) => void;
  onRemoveProducto: (productoId: string) => void;
  getQty: (productoId: string) => number;

  onOpenProductDetail: (productId: string) => void;
};

function Wrapper({ children }: { children: React.ReactNode }) {
  return <div className="order-1 lg:order-none flex-1 min-w-0 min-h-0">{children}</div>;
}

const gridClass =
  "grid gap-2 sm:gap-3 grid-cols-[repeat(auto-fill,minmax(140px,1fr))] sm:grid-cols-[repeat(auto-fill,minmax(170px,1fr))] lg:grid-cols-[repeat(auto-fill,minmax(200px,1fr))]";

const gridCats =
  "grid gap-2 sm:gap-3 grid-cols-[repeat(auto-fill,minmax(135px,1fr))] sm:grid-cols-[repeat(auto-fill,minmax(160px,1fr))] md:grid-cols-[repeat(auto-fill,minmax(170px,1fr))]";

function sameCategorias(
  a?: CategoriaDisplay[] | null,
  b?: CategoriaDisplay[] | null,
): boolean {
  const aa = Array.isArray(a) ? a : [];
  const bb = Array.isArray(b) ? b : [];

  if (aa.length !== bb.length) return false;

  for (let i = 0; i < aa.length; i += 1) {
    const x = aa[i];
    const y = bb[i];

    if (x.ID_Categoria !== y.ID_Categoria) return false;
    if (x.Nombre !== y.Nombre) return false;
    if ((x.urlImagen ?? "") !== (y.urlImagen ?? "")) return false;
    if ((x.Ruta_Imagen ?? "") !== (y.Ruta_Imagen ?? "")) return false;
  }

  return true;
}

function sameProductosWithQty(
  a: ProductoDisplay[] | null | undefined,
  b: ProductoDisplay[] | null | undefined,
  getQtyA: (productoId: string) => number,
  getQtyB: (productoId: string) => number,
): boolean {
  const aa = Array.isArray(a) ? a : [];
  const bb = Array.isArray(b) ? b : [];

  if (aa.length !== bb.length) return false;

  for (let i = 0; i < aa.length; i += 1) {
    const x = aa[i];
    const y = bb[i];

    if (x.ID_Producto !== y.ID_Producto) return false;
    if (x.ID_Categoria !== y.ID_Categoria) return false;
    if (x.Nombre !== y.Nombre) return false;
    if (x.Precio_Venta !== y.Precio_Venta) return false;
    if ((x.urlImagen ?? "") !== (y.urlImagen ?? "")) return false;
    if ((x.Ruta_Imagen ?? "") !== (y.Ruta_Imagen ?? "")) return false;

    const id = x.ID_Producto;
    if (getQtyA(id) !== getQtyB(id)) return false;
  }

  return true;
}

function CatalogGrid({
  variant,
  loading = false,

  categorias,
  productos,
  busqueda,

  onOpenAddProduct,
  onSelectCategoria,
  onAddProducto,
  onRemoveProducto,
  getQty,
  onOpenProductDetail,
}: Props) {
  const cats: CategoriaDisplay[] = Array.isArray(categorias) ? categorias : [];
  const prods: ProductoDisplay[] = Array.isArray(productos) ? productos : [];
  const search: ProductoDisplay[] = Array.isArray(busqueda) ? busqueda : [];

  if (variant === "search") {
    if (loading) {
      return (
        <Wrapper>
          <p className="text-sm text-fg-muted">Buscando…</p>
        </Wrapper>
      );
    }

    return (
      <Wrapper>
        <div className={gridClass}>
          <AddProductoCard onClick={onOpenAddProduct} />

          {search.map((p) => (
            <ProductCard
              key={p.ID_Producto}
              p={p}
              qty={getQty(p.ID_Producto)}
              onAdd={onAddProducto}
              onRemove={onRemoveProducto}
              onInfo={onOpenProductDetail}
            />
          ))}
        </div>
      </Wrapper>
    );
  }

  if (variant === "categories") {
    return (
      <Wrapper>
        <div className={gridCats}>
          <AddProductoCard onClick={onOpenAddProduct} />

          {cats.map((c) => (
            <CategoryCard key={c.ID_Categoria} c={c} onSelect={onSelectCategoria} />
          ))}
        </div>
      </Wrapper>
    );
  }

  if (loading) {
    return (
      <Wrapper>
        <p className="text-sm text-fg-muted">Cargando productos…</p>
      </Wrapper>
    );
  }

  if (prods.length === 0) {
    return (
      <Wrapper>
        <div className={gridClass}>
          <AddProductoCard onClick={onOpenAddProduct} />

          <div className="flex items-center rounded-2xl border border-border bg-surface p-4 text-sm text-fg-muted">
            No hay productos en esta categoría.
          </div>
        </div>
      </Wrapper>
    );
  }

  return (
    <Wrapper>
      <div className={gridClass}>
        <AddProductoCard onClick={onOpenAddProduct} />

        {prods.map((p) => (
          <ProductCard
            key={p.ID_Producto}
            p={p}
            qty={getQty(p.ID_Producto)}
            onAdd={onAddProducto}
            onRemove={onRemoveProducto}
            onInfo={onOpenProductDetail}
          />
        ))}
      </div>
    </Wrapper>
  );
}

export default React.memo(CatalogGrid, (prev, next) => {
  if (prev.variant !== next.variant) return false;
  if (Boolean(prev.loading) !== Boolean(next.loading)) return false;

  if (prev.onOpenAddProduct !== next.onOpenAddProduct) return false;
  if (prev.onSelectCategoria !== next.onSelectCategoria) return false;
  if (prev.onAddProducto !== next.onAddProducto) return false;
  if (prev.onRemoveProducto !== next.onRemoveProducto) return false;
  if (prev.onOpenProductDetail !== next.onOpenProductDetail) return false;

  if (!sameCategorias(prev.categorias, next.categorias)) return false;

  if (
    !sameProductosWithQty(
      prev.productos,
      next.productos,
      prev.getQty,
      next.getQty,
    )
  ) {
    return false;
  }

  if (
    !sameProductosWithQty(
      prev.busqueda,
      next.busqueda,
      prev.getQty,
      next.getQty,
    )
  ) {
    return false;
  }

  return true;
});