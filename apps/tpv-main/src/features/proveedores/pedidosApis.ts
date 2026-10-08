import { commands } from "@tpv/client";
// src/features/proveedores/pedidosApis.ts
//
// API de pedidos a proveedor: una función por comando Tauri, con los tipos que genera ts-rs desde
// Rust. Sin tipos propios ni mappers a camelCase (RI-53): el precio de una línea es `Dinero`.


import type {
  LineaPedidoDto,
  PedidoProveedorDto,
  PedidosActualizarInput,
  PedidosCambiarEstadoInput,
  PedidosCrearInput,
  PedidosPageDto,
} from "@tpv/contracts";

export type { LineaPedidoDto, PedidoProveedorDto, PedidosActualizarInput, PedidosCrearInput };

/** Los estados que la pantalla sabe pintar. El backend los guarda como texto. */
export type PedidoEstado = "borrador" | "enviado" | "cancelado";

export function estadoDelPedido(p: PedidoProveedorDto): PedidoEstado {
  return p.estado === "enviado" || p.estado === "cancelado" ? p.estado : "borrador";
}

export const pedidosGetPage = commands.pedidosProveedorGetPage;
