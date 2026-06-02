// src/components/InventaryComponents/Product.tsx
import React from "react";

type Props = {
  img: string;
  name: string;
  onSelect: () => void;
};

export default function Product({ img, name, onSelect }: Props) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="group w-full sm:w-[220px] text-left"
    >
      <div className="bg-blanco rounded-2xl shadow-sm border m-2 border-black/10 overflow-hidden transition-all duration-200 group-hover:shadow-md group-hover:-translate-y-0.5">
        <div className="relative w-full aspect-[4/3] bg-gris overflow-hidden flex items-center justify-center">
          {img ? (
            <img
              src={img}
              alt={name}
              className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
              loading="lazy"
              draggable={false}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-negro/50 text-sm">
              Sin imagen
            </div>
          )}

          <div className="absolute inset-0 bg-gradient-to-t from-black/45 via-black/0 to-black/0 pointer-events-none" />
        </div>

        <div className="p-4 flex flex-col gap-2">
          <h5 className="text-lg sm:text-xl font-bold text-negro line-clamp-2">
            {name}
          </h5>

          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-negro/80">Ver detalles</p>

            <span className="inline-flex items-center justify-center w-9 h-9 rounded-xl border border-verde text-verde transition-all duration-200 group-hover:bg-verde group-hover:text-white">
              <svg
                className="w-5 h-5"
                aria-hidden="true"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <path
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M9 5l7 7-7 7"
                />
              </svg>
            </span>
          </div>
        </div>
      </div>
    </button>
  );
}
