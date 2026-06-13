// src/features/proveedores/proveedoresApis.ts
//
// API de proveedores — Local-First puro (invokeClient vía @tpv/client). Sustituye dualCall/
// op_id/outbox/afterRemoteOk. Se conservan tipos, firmas, mappers y la superficie exportada.

import { invokeClient } from "@tpv/client";

/* =========================
   Tipos UI
========================= */

export type ProveedorRow = {
    ID_Proveedor: string;
    Nombre_Empresa: string;
    Contacto: string | null;
    Telefono: string | null;
    Email: string | null;
    CIF: string | null;
    Informacion_adicional: string | null;
    Nombre_Imagen: string | null;
    Ruta_Imagen: string | null;
};

export type Categoria = {
    ID_Categoria: string;
    Nombre: string;
    Nombre_Imagen: string | null;
    Ruta_Imagen: string | null;
};

export type ProductoRow = {
    ID_Producto: string;
    ID_Categoria: string | null;
    ID_Proveedor: string | null;
    Nombre: string;
    Precio_Venta: number | null;
    Stock_Actual: number | null;
    Stock_Minimo: number | null;
    Unidad_Medida: string | null;
    Nombre_Imagen: string | null;
    Ruta_Imagen: string | null;

    Cantidad_Pedido_Esperada: number | null;
    Ultima_Entrada: string | null;
    Caducidad_Proxima: string | null;
};

export type ProveedorSaveInput = {
    idProveedor?: string | null;

    nombreEmpresa: string;
    contacto?: string | null;
    telefono?: string | null;
    email?: string | null;
    cif?: string | null;
    informacionAdicional?: string | null;

    nombreImagen?: string | null;
    rutaImagen?: string | null;
};

export type ProductoCreateInput = {
    idCategoria: string;
    idProveedor: string;

    nombre: string;
    precioVenta?: number | null;
    stockActual?: number | null;
    stockMinimo?: number | null;
    unidadMedida?: string | null;
};

/* =========================
   Helpers
========================= */

function toNum(v: any, fallback = 0): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function toNumOrNull(v: any): number | null {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function toNullableStr(v: any): string | null {
    if (v == null) return null;
    const s = String(v).trim();
    return s ? s : null;
}

function toId(v: any): string {
    return String(v ?? "").trim();
}

function resolveReturnedId(data: any, keys: string[]): number {
    if (typeof data === "number") {
        return toNum(data, 0);
    }
    if (data && typeof data === "object") {
        for (const k of keys) {
            const n = toNum(data?.[k], 0);
            if (n > 0) return n;
        }
    }
    return 0;
}

/* =========================
   Mappers
========================= */

function mapProveedor(r: any): ProveedorRow {
    return {
        ID_Proveedor: toId(r?.id_proveedor ?? r?.ID_Proveedor ?? r?.idProveedor),
        Nombre_Empresa: String(
            r?.nombre_empresa ?? r?.Nombre_Empresa ?? r?.nombreEmpresa ?? "",
        ),
        Contacto: toNullableStr(r?.contacto ?? r?.Contacto),
        Telefono: toNullableStr(r?.telefono ?? r?.Telefono),
        Email: toNullableStr(r?.email ?? r?.Email),
        CIF: toNullableStr(r?.cif ?? r?.CIF),
        Informacion_adicional: toNullableStr(
            r?.informacion_adicional ??
            r?.Informacion_adicional ??
            r?.informacionAdicional,
        ),
        Nombre_Imagen: toNullableStr(
            r?.nombre_imagen ?? r?.Nombre_Imagen ?? r?.nombreImagen,
        ),
        Ruta_Imagen: toNullableStr(
            r?.ruta_imagen ?? r?.Ruta_Imagen ?? r?.rutaImagen,
        ),
    };
}

function mapCategoria(r: any): Categoria {
    return {
        ID_Categoria: toId(r?.id_categoria ?? r?.ID_Categoria ?? r?.idCategoria),
        Nombre: String(r?.nombre ?? r?.Nombre ?? ""),
        Nombre_Imagen: toNullableStr(
            r?.nombre_imagen ?? r?.Nombre_Imagen ?? r?.nombreImagen,
        ),
        Ruta_Imagen: toNullableStr(
            r?.ruta_imagen ?? r?.Ruta_Imagen ?? r?.rutaImagen,
        ),
    };
}

function mapProducto(r: any): ProductoRow {
    return {
        ID_Producto: toId(r?.id_producto ?? r?.ID_Producto ?? r?.idProducto),
        ID_Categoria: toNullableStr(
            r?.id_categoria ?? r?.ID_Categoria ?? r?.idCategoria,
        ),
        ID_Proveedor: toNullableStr(
            r?.id_proveedor ?? r?.ID_Proveedor ?? r?.idProveedor,
        ),
        Nombre: String(r?.nombre ?? r?.Nombre ?? ""),
        Precio_Venta: toNumOrNull(
            r?.precio_venta ?? r?.Precio_Venta ?? r?.precioVenta ?? null,
        ),
        Stock_Actual: toNumOrNull(
            r?.stock_actual ?? r?.Stock_Actual ?? r?.stockActual ?? null,
        ),
        Stock_Minimo: toNumOrNull(
            r?.stock_minimo ?? r?.Stock_Minimo ?? r?.stockMinimo ?? null,
        ),
        Unidad_Medida: toNullableStr(
            r?.unidad_medida ?? r?.Unidad_Medida ?? r?.unidadMedida,
        ),
        Nombre_Imagen: toNullableStr(
            r?.nombre_imagen ?? r?.Nombre_Imagen ?? r?.nombreImagen,
        ),
        Ruta_Imagen: toNullableStr(
            r?.ruta_imagen ?? r?.Ruta_Imagen ?? r?.rutaImagen,
        ),

        Cantidad_Pedido_Esperada: toNumOrNull(
            r?.cantidad_pedido_esperada ??
            r?.Cantidad_Pedido_Esperada ??
            r?.cantidadPedidoEsperada ??
            null,
        ),
        Ultima_Entrada: toNullableStr(
            r?.ultima_entrada ?? r?.Ultima_Entrada ?? r?.ultimaEntrada,
        ),
        Caducidad_Proxima: toNullableStr(
            r?.caducidad_proxima ?? r?.Caducidad_Proxima ?? r?.caducidadProxima,
        ),
    };
}

/* =========================
   API lectura
========================= */

export async function proveedoresGetAll(): Promise<ProveedorRow[]> {
    const rows = await invokeClient<any[]>("proveedores_get_all");
    return Array.isArray(rows) ? rows.map(mapProveedor) : [];
}

export async function proveedoresGetProductos(params: {
    idProveedor: string;
}): Promise<ProductoRow[]> {
    const rows = await invokeClient<any[]>("proveedores_get_productos", {
        args: { id_proveedor: params.idProveedor },
    });
    return Array.isArray(rows) ? rows.map(mapProducto) : [];
}

export async function proveedoresGetCategorias(): Promise<Categoria[]> {
    const rows = await invokeClient<any[]>("proveedores_get_categorias");
    return Array.isArray(rows) ? rows.map(mapCategoria) : [];
}

export async function proveedoresGetProductosAll(): Promise<ProductoRow[]> {
    const rows = await invokeClient<any[]>("proveedores_get_productos_all");
    return Array.isArray(rows) ? rows.map(mapProducto) : [];
}

/* =========================
   Escrituras
========================= */

export async function proveedoresSave(
    input: ProveedorSaveInput,
): Promise<boolean> {
    const r = await invokeClient<any>("proveedores_save", {
        args: {
            id_proveedor: input.idProveedor ?? null,
            nombre_empresa: String(input.nombreEmpresa ?? ""),
            contacto: input.contacto ?? null,
            telefono: input.telefono ?? null,
            email: input.email ?? null,
            cif: input.cif ?? null,
            informacion_adicional: input.informacionAdicional ?? null,
            nombre_imagen: input.nombreImagen ?? null,
            ruta_imagen: input.rutaImagen ?? null,
        },
    });
    return typeof r === "boolean" ? r : true;
}

export async function proveedoresDelete(params: {
    idProveedor: string;
}): Promise<boolean> {
    const r = await invokeClient<any>("proveedores_delete", {
        args: { id_proveedor: params.idProveedor },
    });
    return typeof r === "boolean" ? r : true;
}

export async function proveedoresSetVinculos(params: {
    idProveedor: string;
    productoIds: string[];
}): Promise<boolean> {
    const r = await invokeClient<any>("proveedores_set_vinculos", {
        args: {
            id_proveedor: params.idProveedor,
            producto_ids: (params.productoIds ?? [])
                .map(Number)
                .filter((n) => Number.isFinite(n) && n > 0),
        },
    });
    return typeof r === "boolean" ? r : true;
}

export async function proveedoresCreateProducto(
    input: ProductoCreateInput,
): Promise<number> {
    const r = await invokeClient<any>("proveedores_create_producto", {
        args: {
            id_categoria: input.idCategoria,
            id_proveedor: input.idProveedor,
            nombre: String(input.nombre ?? ""),
            precio_venta: input.precioVenta ?? null,
            stock_actual: input.stockActual ?? null,
            stock_minimo: input.stockMinimo ?? null,
            unidad_medida: input.unidadMedida ?? null,
        },
    });
    return resolveReturnedId(r, ["id_producto", "idProducto", "ID_Producto"]);
}
