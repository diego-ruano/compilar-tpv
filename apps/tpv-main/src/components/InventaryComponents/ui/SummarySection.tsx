// src/components/InventaryComponents/ui/SummarySection.tsx
import React from "react";
import ListProducts from "../ListProducts";
import ItemListProduct from "../ItemListProduct";
import type { ProductoResumen } from "../api/inventarioAPI";
import { formatCantidad, formatDateES } from "../utils/inventarioFormat";

function SummaryList({
    title,
    rows,
    emptyText,
    keyFn,
}: {
    title: string;
    rows: ProductoResumen[];
    emptyText: string;
    keyFn: (p: ProductoResumen, idx: number) => string;
}) {
    return (
        <ListProducts title={title}>
            <div className="rounded-2xl border border-negro/10 overflow-hidden flex-1 min-h-0 flex flex-col">
                <div className="flex-none bg-gris/40">
                    <ItemListProduct
                        className="font-bold"
                        cantidad="Cantidad"
                        nombre="Nombre"
                        caducidad="Caducidad"
                        lote="Lote"
                        precio="Precio"
                    />
                </div>

                <div className="flex-1 min-h-0 overflow-auto pr-2 pb-4">
                    {rows.length === 0 ? (
                        <p className="text-center text-negro/60 py-4">{emptyText}</p>
                    ) : (
                        rows.map((p, idx) => (
                            <div key={keyFn(p, idx)} className="border-t border-negro/10">
                                <ItemListProduct
                                    cantidad={formatCantidad(p.Stock_Actual, p.Unidad_Medida)}
                                    nombre={p.Nombre}
                                    caducidad={formatDateES(p.Caducidad_Proxima)}
                                    lote={p.Lote ?? "—"}
                                    precio={p.Precio_Venta != null ? String(p.Precio_Venta) : "—"}
                                />
                            </div>
                        ))
                    )}
                </div>
            </div>
        </ListProducts>
    );
}

export default function SummarySection({
    proximosCaducar,
    menosCantidad,
}: {
    proximosCaducar: ProductoResumen[];
    menosCantidad: ProductoResumen[];
}) {
    return (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <SummaryList
                title="MÁS PRÓXIMO A CADUCAR"
                rows={proximosCaducar}
                emptyText="No hay productos con caducidad."
                keyFn={(p, idx) => `${p.Nombre}-${p.Caducidad_Proxima ?? "no"}-${idx}`}
            />

            <SummaryList
                title="MENOS CANTIDAD EN INVENTARIO"
                rows={menosCantidad}
                emptyText="No hay productos."
                keyFn={(p, idx) => `${p.Nombre}-${p.Stock_Actual ?? 0}-${idx}`}
            />
        </div>
    );
}