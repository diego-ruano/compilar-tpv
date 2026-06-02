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
        bg-blanco
        rounded-2xl
        p-3 sm:p-4
        shadow-xs
        border border-black/5
        flex flex-col
        h-[320px]
        min-h-0
      "
    >
      <h3 className="text-center font-extrabold text-lg mb-3 flex-none">{title}</h3>

      <div className="flex-1 min-h-0 flex flex-col">{children}</div>
    </div>
  );
}

export default ListProducts;
