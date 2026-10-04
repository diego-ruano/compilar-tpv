// src/features/proveedores/proveedoresApis.ts
//
// API de proveedores: una función por comando Tauri, con los tipos que genera ts-rs desde Rust.
//
// Aquí no se redeclaran tipos ni se normaliza lo que vuelve (RI-53). Los antiguos mappers
// convertían los DTO a otros nombres (`precio_venta` → `Precio_Venta`) y los tipos a mano
// declaraban el precio como `number`, que es por donde un producto dado de alta a «3» se guardaba a
// 3 céntimos.

import { invokeClient } from "@tpv/client";
import type {
    CategoriaProveedorDto,
    ProductoProveedorDto,
    ProveedorDto,
    ProveedoresSetVinculosInput,
    ProveedorSaveInput,
} from "@tpv/contracts";

export type { CategoriaProveedorDto, ProductoProveedorDto, ProveedorDto };

/* =========================
   API lectura
========================= */

export function proveedoresGetAll(): Promise<ProveedorDto[]> {
    return invokeClient<ProveedorDto[]>("proveedores_get_all");
}

export function proveedoresGetProductos(idProveedor: string): Promise<ProductoProveedorDto[]> {
    return invokeClient<ProductoProveedorDto[]>("proveedores_get_productos", {
        args: { id_proveedor: idProveedor },
    });
}

export function proveedoresGetCategorias(): Promise<CategoriaProveedorDto[]> {
    return invokeClient<CategoriaProveedorDto[]>("proveedores_get_categorias");
}

export function proveedoresGetProductosAll(): Promise<ProductoProveedorDto[]> {
    return invokeClient<ProductoProveedorDto[]>("proveedores_get_productos_all");
}

/* =========================
   Escrituras
========================= */

export async function proveedoresSave(args: ProveedorSaveInput): Promise<boolean> {
    return (await invokeClient<boolean>("proveedores_save", { args })) !== false;
}

export async function proveedoresDelete(idProveedor: string): Promise<boolean> {
    const r = await invokeClient<boolean>("proveedores_delete", {
        args: { id_proveedor: idProveedor },
    });
    return r !== false;
}

export async function proveedoresSetVinculos(args: ProveedoresSetVinculosInput): Promise<boolean> {
    return (await invokeClient<boolean>("proveedores_set_vinculos", { args })) !== false;
}
