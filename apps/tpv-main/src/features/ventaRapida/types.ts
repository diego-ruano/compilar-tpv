import type { CategoriaRow, Dinero, ProductoRow } from "@tpv/contracts";

/** Una categoría o un producto del catálogo, con la URL de su imagen ya resuelta para pintar. */
export type CategoriaDisplay = CategoriaRow & { urlImagen: string };
export type ProductoDisplay = ProductoRow & { urlImagen: string };

export type TicketItem = {
    id: string;
    detalleId: string;
    productoId: string;
    nombre: string;
    precio: Dinero;
    pagado: boolean;
    seleccionado: boolean;
    categoriaNombre?: string | null;
    /** Tipo de IVA con el que se vendió la línea; `null` = el general del negocio. */
    ivaPercent?: number | null;

    notas?: string | null;
};

export type Paso = "categorias" | "productos" | "metodo" | "efectivo";

export type { Denominacion as Denom } from "../../shared/lib/efectivo";
