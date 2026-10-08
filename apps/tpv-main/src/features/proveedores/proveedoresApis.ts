import { commands } from "@tpv/client";
// src/features/proveedores/proveedoresApis.ts
//
// API de proveedores: una función por comando Tauri, con los tipos que genera Specta desde Rust.
//
// Aquí no se redeclaran tipos ni se normaliza lo que vuelve (RI-53). Los antiguos mappers
// convertían los DTO a otros nombres (`precio_venta` → `Precio_Venta`) y los tipos a mano
// declaraban el precio como `number`, que es por donde un producto dado de alta a «3» se guardaba a
// 3 céntimos.


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

export function proveedoresGetProductos(idProveedor: string): Promise<ProductoProveedorDto[]> {
    return commands.proveedoresGetProductos({ id_proveedor: idProveedor });
}

/* =========================
   Escrituras
========================= */

export async function proveedoresSave(args: ProveedorSaveInput): Promise<boolean> {
    return (await commands.proveedoresSave(args)) !== false;
}

export async function proveedoresDelete(idProveedor: string): Promise<boolean> {
    const r = await commands.proveedoresDelete({ id_proveedor: idProveedor });
    return r !== false;
}

export async function proveedoresSetVinculos(args: ProveedoresSetVinculosInput): Promise<boolean> {
    return (await commands.proveedoresSetVinculos(args)) !== false;
}
