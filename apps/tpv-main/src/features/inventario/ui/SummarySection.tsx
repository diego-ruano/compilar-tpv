// src/features/inventario/ui/SummarySection.tsx
import ListProducts from "../ListProducts";
import ItemListProduct from "../ItemListProduct";
import type { ProductoResumenDto } from "@tpv/contracts";

import { eur } from "../../../shared/lib/dinero";
import { formatCantidad, formatDateES } from "../utils/inventarioFormat";

function SummaryList({
    title,
    rows,
    emptyText,
    keyFn,
}: {
    title: string;
    rows: ProductoResumenDto[];
    emptyText: string;
    keyFn: (p: ProductoResumenDto, idx: number) => string;
}) {
    // INV-MEJ-01: vacía, el mensaje va sin la tabla. Con su ancho mínimo, en un móvil obligaba a
    // desplazarse de lado para leer que no hay nada, y lo cortaba.
    if (rows.length === 0) {
        return (
            <ListProducts title={title}>
                <p className="rounded-2xl border border-border py-4 text-center text-fg-muted">{emptyText}</p>
            </ListProducts>
        );
    }
    return (
        <ListProducts title={title}>
            <div className="flex min-h-0 flex-1 overflow-x-auto rounded-2xl border border-border [scrollbar-gutter:stable]">
              <div className="flex min-w-[620px] flex-1 flex-col">
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

                <div className="min-h-0 flex-1 overflow-y-auto pb-4 pr-2">
                    {rows.map((p, idx) => (
                            <div key={keyFn(p, idx)} className="border-t border-border">
                                <ItemListProduct
                                    cantidad={formatCantidad(p.Stock_Actual, p.Unidad_Medida)}
                                    nombre={p.Nombre}
                                    caducidad={formatDateES(p.Caducidad_Proxima)}
                                    lote={p.Lote ?? "—"}
                                    precio={p.Precio_Venta != null ? eur(p.Precio_Venta) : "—"}
                                />
                            </div>
                        ))}
                </div>
              </div>
            </div>
        </ListProducts>
    );
}

export default function SummarySection({
    proximosCaducar,
    menosCantidad,
}: {
    proximosCaducar: ProductoResumenDto[];
    menosCantidad: ProductoResumenDto[];
}) {
    return (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 lg:gap-4">
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
