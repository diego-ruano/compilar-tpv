// src/features/inventario/ListProducts.tsx
import React from "react";

function ListProducts({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="
        flex h-[280px] min-h-0 flex-col sm:h-[320px]
        rounded-2xl border border-border bg-surface
        p-3 shadow-sm sm:p-4
      "
    >
      <h3 className="mb-3 flex-none text-center text-sm font-extrabold text-fg sm:text-lg">{title}</h3>

      <div className="flex-1 min-h-0 flex flex-col">{children}</div>
    </div>
  );
}

export default ListProducts;
