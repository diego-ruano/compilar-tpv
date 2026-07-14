import { invokeClient } from "@tpv/client";

// El envío de correo lo hace SIEMPRE el worker (Cloudflare Email Service). Ya no hay configuración
// SMTP local ni credenciales del negocio (DB-04): solo se construye el pedido y se manda. En
// offline no se puede enviar (hace falta el worker).

export type LineaEmailInput = {
  nombre_producto: string;
  cantidad: number;
  precio_unitario?: number | null;
  unidad?: string | null;
};

export type EnviarPedidoEmailInput = {
  email_destino: string;
  nombre_proveedor: string;
  notas?: string | null;
  lineas: LineaEmailInput[];
};

export async function emailEnviarPedido(input: EnviarPedidoEmailInput): Promise<void> {
  await invokeClient<void>("email_enviar_pedido", { args: input });
}
