import { invokeClient } from "@tpv/client";

export type PedidoEstado = "borrador" | "enviado" | "cancelado";

export type LineaPedido = {
  id: string;
  nombreProducto: string;
  cantidad: number;
  precioUnitario: number | null;
  unidad: string | null;
};

export type PedidoRow = {
  id: string;
  idProveedor: string | null;
  nombreProveedor: string | null;
  emailDestino: string | null;
  estado: PedidoEstado;
  fechaCreacion: string;
  fechaEnvio: string | null;
  notas: string | null;
  lineas: LineaPedido[];
};

/* ── Inputs ── */

export type LineaPedidoInput = {
  idLinea: string;
  nombreProducto: string;
  cantidad: number;
  precioUnitario: number | null;
  unidad: string | null;
};

export type PedidoCrearInput = {
  idPedido: string;
  idProveedor: string | null;
  emailDestino: string | null;
  notas: string | null;
  lineas: LineaPedidoInput[];
};

export type PedidoActualizarInput = {
  idPedido: string;
  idProveedor: string | null;
  emailDestino: string | null;
  notas: string | null;
  lineas: LineaPedidoInput[];
};

export type PedidoCambiarEstadoInput = {
  idPedido: string;
  estado: string;
  fechaEnvio?: string | null;
};

/* ── Mappers ── */

function mapLinea(r: any): LineaPedido {
  return {
    id: String(r?.id_linea ?? ""),
    nombreProducto: String(r?.nombre_producto ?? ""),
    cantidad: Number(r?.cantidad ?? 1),
    precioUnitario: r?.precio_unitario != null ? Number(r.precio_unitario) : null,
    unidad: r?.unidad ? String(r.unidad) : null,
  };
}

function mapPedido(r: any): PedidoRow {
  return {
    id: String(r?.id_pedido ?? ""),
    idProveedor: r?.id_proveedor ? String(r.id_proveedor) : null,
    nombreProveedor: r?.nombre_proveedor ? String(r.nombre_proveedor) : null,
    emailDestino: r?.email_destino ? String(r.email_destino) : null,
    estado: (r?.estado ?? "borrador") as PedidoEstado,
    fechaCreacion: String(r?.fecha_creacion ?? ""),
    fechaEnvio: r?.fecha_envio ? String(r.fecha_envio) : null,
    notas: r?.notas ? String(r.notas) : null,
    lineas: Array.isArray(r?.lineas) ? r.lineas.map(mapLinea) : [],
  };
}

function toLineasPayload(lineas: LineaPedidoInput[]) {
  return lineas.map((l) => ({
    id_linea: l.idLinea,
    nombre_producto: l.nombreProducto,
    cantidad: l.cantidad,
    precio_unitario: l.precioUnitario,
    unidad: l.unidad,
  }));
}

/* ── API ── */

export async function pedidosGetAll(): Promise<PedidoRow[]> {
  const rows = await invokeClient<any[]>("pedidos_proveedor_get_all");
  return (rows ?? []).map(mapPedido);
}

export async function pedidosCrear(input: PedidoCrearInput): Promise<string> {
  return invokeClient<string>("pedidos_proveedor_crear", {
    args: {
      id_pedido: input.idPedido,
      id_proveedor: input.idProveedor,
      email_destino: input.emailDestino,
      notas: input.notas,
      lineas: toLineasPayload(input.lineas),
    },
  });
}

export async function pedidosActualizar(input: PedidoActualizarInput): Promise<boolean> {
  return invokeClient<boolean>("pedidos_proveedor_actualizar", {
    args: {
      id_pedido: input.idPedido,
      id_proveedor: input.idProveedor,
      email_destino: input.emailDestino,
      notas: input.notas,
      lineas: toLineasPayload(input.lineas),
    },
  });
}

export async function pedidosCambiarEstado(input: PedidoCambiarEstadoInput): Promise<boolean> {
  return invokeClient<boolean>("pedidos_proveedor_cambiar_estado", {
    args: {
      id_pedido: input.idPedido,
      estado: input.estado,
      fecha_envio: input.fechaEnvio ?? null,
    },
  });
}
