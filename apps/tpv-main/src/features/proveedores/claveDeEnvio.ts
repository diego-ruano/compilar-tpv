// src/features/proveedores/claveDeEnvio.ts
//
// La clave de idempotencia del correo de un pedido a un proveedor (`id_envio`, `/v1/email/enviar-pedido`).
//
// El correo sale de la nube. Si sale y lo que falla es la vuelta (la nube contesta tarde, o falla
// guardar el pedido después), la pantalla dice que no se pudo y quien lo manda lo vuelve a intentar:
// sin una clave que se repita, el proveedor recibía dos correos del mismo pedido. Un reintento del
// mismo pedido, sin cambiar nada, lleva la misma clave, y la nube no lo vuelve a mandar. Un pedido
// cambiado, u otro pedido, lleva una nueva.

export type EnvioEnCurso = { huella: string; id: string };

/** La clave para mandar `correo` del pedido `idPedido`, reutilizando la del intento anterior si es el mismo. */
export function claveDeEnvio(
  enCurso: EnvioEnCurso | null,
  idPedido: string,
  correo: unknown,
  nuevoId: () => string = () => crypto.randomUUID(),
): EnvioEnCurso {
  const huella = JSON.stringify([idPedido, correo]);
  return enCurso?.huella === huella ? enCurso : { huella, id: nuevoId() };
}
