import { commands } from "@tpv/client";
// src/features/proveedores/pedidosApis.ts
//
// API de pedidos a proveedor: una función por comando Tauri, con los tipos que genera Specta desde
// Rust. Sin tipos propios ni mappers a camelCase (RI-53): el precio de una línea es `Dinero`.


import type { PedidoProveedorDto } from "@tpv/contracts";

/** Los estados que la pantalla sabe pintar. El backend los guarda como texto. */
export type PedidoEstado = "borrador" | "enviado" | "cancelado";

export function estadoDelPedido(p: PedidoProveedorDto): PedidoEstado {
  return p.estado === "enviado" || p.estado === "cancelado" ? p.estado : "borrador";
}

export const pedidosGetPage = commands.pedidosProveedorGetPage;
