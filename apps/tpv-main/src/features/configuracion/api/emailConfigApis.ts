import { invokeClient } from "@tpv/client";
import type { EnviarPedidoEmailInput } from "@tpv/contracts";

// El envío de correo lo hace SIEMPRE el worker (Cloudflare Email Service). Ya no hay configuración
// SMTP local ni credenciales del negocio (DB-04): solo se construye el pedido y se manda. En
// offline no se puede enviar (hace falta el worker).

export async function emailEnviarPedido(args: EnviarPedidoEmailInput): Promise<void> {
  await invokeClient<void>("email_enviar_pedido", { args });
}
