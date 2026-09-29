// src/features/proveedores/pedidosApis.ts
//
// API de pedidos a proveedor: una función por comando Tauri, con los tipos que genera ts-rs desde
// Rust. Sin tipos propios ni mappers a camelCase (RI-53): el precio de una línea es `Dinero`.

import { invokeClient } from "@tpv/client";
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

export function pedidosGetPage(params: {
  limit: number;
  offset: number;
  search?: string;
}): Promise<PedidosPageDto> {
  return invokeClient<PedidosPageDto>("pedidos_proveedor_get_page", {
    args: { limit: params.limit, offset: params.offset, search: params.search || undefined },
  });
}

export function pedidosCrear(args: PedidosCrearInput): Promise<string> {
  return invokeClient<string>("pedidos_proveedor_crear", { args });
}

export function pedidosActualizar(args: PedidosActualizarInput): Promise<boolean> {
  return invokeClient<boolean>("pedidos_proveedor_actualizar", { args });
}

export function pedidosCambiarEstado(args: PedidosCambiarEstadoInput): Promise<boolean> {
  return invokeClient<boolean>("pedidos_proveedor_cambiar_estado", { args });
}
