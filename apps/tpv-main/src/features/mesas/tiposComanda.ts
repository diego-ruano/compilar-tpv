import type { CategoriaVendibleOut, ProductoVendibleOut, Dinero } from "@tpv/contracts";

export type CategoriaDisplay = CategoriaVendibleOut & { urlImagen: string };
export type ProductoDisplay = ProductoVendibleOut & { urlImagen: string };

export type TicketItem = {
    id: string; // ID_Detalle
    productoId: string;
    nombre: string;
    precio: Dinero;
    pagado: boolean;
    seleccionado: boolean;
    estadoCocina: "PENDIENTE" | "PREPARADO" | string;
    pasaCocina: boolean;
    notas: string | null;
    /** Lo que se pidió distinto: el JSON de `Cambios_Ingredientes` (ver `inventario/ingredientes.ts`). */
    cambiosIngredientes: string | null;
    /** Tipo de IVA con el que se vendió la línea; `null` = el general del negocio. */
    iva_percent: number | null;
};

export type Paso = "categorias" | "productos" | "metodo" | "efectivo";
