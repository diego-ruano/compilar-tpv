// src/features/proveedores/claveDeEnvio.ts
//
// La clave de idempotencia del correo de un pedido a un proveedor (`id_envio`, `/v1/email/enviar-pedido`).
//
// El correo sale de la nube. Si sale y lo que falla es la vuelta (la nube contesta tarde, o falla
// guardar el pedido después), la pantalla dice que no se pudo y quien lo manda lo vuelve a intentar:
// sin una clave que se repita, el proveedor recibía dos correos del mismo pedido. Un reintento del
// mismo pedido, sin cambiar nada, lleva la misma clave, y la nube no lo vuelve a mandar. Un pedido
// cambiado lleva una nueva.
//
// Las claves de los envíos que no han terminado bien se guardan por pedido, fuera de la pantalla:
// salir de Pedidos y volver, o mandar otro pedido entretanto, no las pierde. Duran lo que la
// aplicación esté abierta; un envío que termina bien olvida la suya (`envioTerminado`), y mandarlo
// otra vez después es otro envío.

type EnvioEnCurso = { huella: string; id: string };

const enCurso = new Map<string, EnvioEnCurso>();

/** La clave para mandar `correo` del pedido `idPedido`: la del intento anterior si es el mismo correo. */
export function claveDeEnvio(idPedido: string, correo: unknown, nuevoId: () => string = () => crypto.randomUUID()): string {
  const huella = JSON.stringify(correo);
  const anterior = enCurso.get(idPedido);
  if (anterior?.huella === huella) return anterior.id;
  const id = nuevoId();
  enCurso.set(idPedido, { huella, id });
  return id;
}

/** El envío del pedido terminó bien: su clave ya no sirve para reintentarlo. */
export function envioTerminado(idPedido: string): void {
  enCurso.delete(idPedido);
}
