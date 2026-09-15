export type Categoria = {
    ID_Categoria: string;
    Nombre: string;
    Nombre_Imagen: string | null;
    Ruta_Imagen: string | null;

    Vendible?: number; // 0/1
};

export type CategoriaDisplay = Categoria & { urlImagen: string };

export type Producto = {
    ID_Producto: string;
    ID_Categoria: string;
    Nombre: string;
    Precio_Venta: number;
    Stock_Actual: number;
    Stock_Minimo: number;
    Unidad_Medida: string | null;
    Nombre_Imagen: string | null;
    Ruta_Imagen: string | null;
};

export type ProductoDisplay = Producto & { urlImagen: string };

export type TicketItem = {
    id: string;
    detalleId: string;
    productoId: string;
    nombre: string;
    precio: number;
    pagado: boolean;
    seleccionado: boolean;
    categoriaNombre?: string | null;
    /** Tipo de IVA con el que se vendió la línea; `null` = el general del negocio. */
    ivaPercent?: number | null;

    notas?: string | null;
};

export type Paso = "categorias" | "productos" | "metodo" | "efectivo";

export type { Denominacion as Denom } from "../../shared/lib/efectivo";
