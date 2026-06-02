export type Categoria = {
    ID_Categoria: number;
    Nombre: string;
    Nombre_Imagen: string | null;
    Ruta_Imagen: string | null;

    Vendible?: number; // 0/1
};

export type CategoriaDisplay = Categoria & { urlImagen: string };

export type Producto = {
    ID_Producto: number;
    ID_Categoria: number;
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
    detalleId: number;
    productoId: number;
    nombre: string;
    precio: number;
    pagado: boolean;
    seleccionado: boolean;

    notas?: string | null;
};

export type Paso = "categorias" | "productos" | "metodo" | "efectivo";

export type Denom = { label: string; value: number };

export const DENOMS: Denom[] = [
    { label: "200€", value: 200 },
    { label: "100€", value: 100 },
    { label: "50€", value: 50 },
    { label: "20€", value: 20 },
    { label: "10€", value: 10 },
    { label: "5€", value: 5 },
    { label: "2€", value: 2 },
    { label: "1€", value: 1 },
    { label: "0,50€", value: 0.5 },
    { label: "0,20€", value: 0.2 },
    { label: "0,10€", value: 0.1 },
    { label: "0,05€", value: 0.05 },
];
