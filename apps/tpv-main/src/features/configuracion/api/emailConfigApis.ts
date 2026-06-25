import { invokeClient } from "@tpv/client";

export type EmailModo = "managed" | "smtp";

export type EmailConfigData = {
  modo: EmailModo;
  smtp_host: string;
  smtp_port: number;
  smtp_user: string;
  smtp_password: string;
  smtp_from_email: string;
  smtp_from_name: string;
  smtp_use_tls: boolean;
};

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

export async function emailConfigGet(): Promise<EmailConfigData> {
  return invokeClient<EmailConfigData>("email_config_get");
}

export async function emailConfigPatch(data: EmailConfigData): Promise<void> {
  await invokeClient<void>("email_config_patch", { args: data });
}

export async function emailEnviarPedido(input: EnviarPedidoEmailInput): Promise<void> {
  await invokeClient<void>("email_enviar_pedido", { args: input });
}
