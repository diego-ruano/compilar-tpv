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
