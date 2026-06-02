// components/inventario/InventoryHeader.tsx
import React from "react";
import { ReactComponent as LapizSVG } from "../../../assets/svg/LapizSVG.svg";

export default function InventoryHeader({
    titulo,
    categoriaSeleccionada,
    onBack,
    onNewCategory,
    onNewProduct,
}: {
    titulo: string;
    categoriaSeleccionada: any | null;
    onBack: () => void;
    onNewCategory: () => void;
    onNewProduct: () => void;
}) {
    return (
        <div className="bg-blanco w-full p-3 sm:p-4 rounded-2xl shadow-xs border border-black/5">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-center">
                {/* Left */}
                <div className="flex items-center justify-start">
                    {categoriaSeleccionada ? (
                        <button
                            type="button"
                            onClick={onBack}
                            className="flex cursor-pointer items-center gap-2 text-negro font-semibold hover:opacity-80 transition"
                        >
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth={2}
                                className="w-5 h-5"
                            >
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                            </svg>
                            <span>Volver</span>
                        </button>
                    ) : (
                        <div className="hidden sm:block" />
                    )}
                </div>

                {/* Center */}
                <div className="text-center">
                    <h2 className="text-lg sm:text-2xl font-extrabold">{titulo}</h2>
                    <p className="text-sm text-negro/60">
                        {!categoriaSeleccionada
                            ? "Gestiona tus categorías"
                            : "Gestiona los productos de esta categoría"}
                    </p>
                </div>

                {/* Right */}
                <div className="flex justify-center sm:justify-end">
                    {!categoriaSeleccionada ? (
                        <button type="button" onClick={onNewCategory} className="w-full sm:w-auto">
                            <div className="group flex gap-2 w-full sm:w-fit justify-center items-center cursor-pointer border-2 border-verde rounded-2xl px-4 py-2 text-verde transition-all duration-300 ease-out hover:bg-verde hover:text-white hover:shadow-md">
                                <LapizSVG
                                    width={22}
                                    height={22}
                                    className="transition-transform duration-300 group-hover:-translate-y-0.5 group-hover:rotate-6"
                                />
                                <p className="font-bold">Nueva categoría</p>
                            </div>
                        </button>
                    ) : (
                        <button type="button" onClick={onNewProduct} className="w-full sm:w-auto">
                            <div className="group flex gap-2 w-full sm:w-fit justify-center items-center cursor-pointer border-2 border-verde rounded-2xl px-4 py-2 text-verde transition-all duration-300 ease-out hover:bg-verde hover:text-white hover:shadow-md">
                                <LapizSVG
                                    width={22}
                                    height={22}
                                    className="transition-transform duration-300 group-hover:-translate-y-0.5 group-hover:rotate-6"
                                />
                                <p className="font-bold">Nuevo producto</p>
                            </div>
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
