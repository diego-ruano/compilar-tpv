// src/features/InventaryComponents/ui/SummarySection.tsx
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
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border">
                <div className="flex-none bg-surface-2 text-fg-muted">
                    <ItemListProduct
                        className="font-bold"
                        cantidad="Cantidad"
                        nombre="Nombre"
                        caducidad="Caducidad"
                        lote="Lote"
                        precio="Precio"
                    />
                </div>

                <div className="min-h-0 flex-1 overflow-auto pr-2 pb-4">
                    {rows.length === 0 ? (
                        <p className="py-4 text-center text-fg-muted">{emptyText}</p>
                    ) : (
                        rows.map((p, idx) => (
                            <div key={keyFn(p, idx)} className="border-t border-border">
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