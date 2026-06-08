// components/InventaryComponents/ListProducts.tsx
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
        flex h-[320px] min-h-0 flex-col
        rounded-2xl border border-border bg-surface
        p-3 shadow-sm sm:p-4
      "
    >
      <h3 className="mb-3 flex-none text-center text-lg font-extrabold text-fg">{title}</h3>

      <div className="flex-1 min-h-0 flex flex-col">{children}</div>
    </div>
  );
}

export default ListProducts;
