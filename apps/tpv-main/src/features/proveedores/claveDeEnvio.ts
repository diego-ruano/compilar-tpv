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
// Las claves de los envíos que no han terminado bien se guardan por pedido, fuera de la pantalla y
// en el almacenamiento de la aplicación: salir de Pedidos, mandar otro pedido entretanto o cerrar y
// volver a abrir no las pierde. Un envío que termina bien olvida la suya (`envioTerminado`), y mandarlo
// otra vez después es otro envío. Las que nadie retoma caducan a la semana. Si el almacenamiento no
// está, duran lo que la aplicación esté abierta. Los ids de pedido son UUID y la nube pone el negocio
// delante de la clave: una clave que quedara de otro negocio no choca con nada.

type EnvioEnCurso = { huella: string; id: string; desde: number };

const CLAVE_ALMACEN = "tpv:pedidos:enviosEnCurso:v1";
const CADUCA_MS = 7 * 24 * 60 * 60 * 1000;

/** Sin almacenamiento (o en los tests), aquí. */
let enMemoria: Record<string, EnvioEnCurso> = {};

type Opciones = { almacen?: Storage | null; ahora?: number; nuevoId?: () => string };

function almacenDeLaApp(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function esEnvio(v: unknown): v is EnvioEnCurso {
  const e = v as EnvioEnCurso;
  return !!e && typeof e === "object" && typeof e.huella === "string" && typeof e.id === "string" && typeof e.desde === "number";
}

function leer(almacen: Storage | null): Record<string, EnvioEnCurso> {
  if (!almacen) return { ...enMemoria };
  try {
    const guardados: unknown = JSON.parse(almacen.getItem(CLAVE_ALMACEN) ?? "{}");
    if (!guardados || typeof guardados !== "object") return {};
    return Object.fromEntries(Object.entries(guardados).filter(([, e]) => esEnvio(e))) as Record<string, EnvioEnCurso>;
  } catch {
    // Ilegible: como si no hubiera nada. Lo peor que pasa es que un reintento lleve otra clave.
    return {};
  }
}

function escribir(almacen: Storage | null, todos: Record<string, EnvioEnCurso>, ahora: number): void {
  const vivos = Object.fromEntries(Object.entries(todos).filter(([, e]) => ahora - e.desde <= CADUCA_MS));
  if (!almacen) {
    enMemoria = vivos;
    return;
  }
  try {
    almacen.setItem(CLAVE_ALMACEN, JSON.stringify(vivos));
  } catch {
    enMemoria = vivos;
  }
}

/** La clave para mandar `correo` del pedido `idPedido`: la del intento anterior si es el mismo correo. */
export function claveDeEnvio(idPedido: string, correo: unknown, opciones: Opciones = {}): string {
  const almacen = opciones.almacen === undefined ? almacenDeLaApp() : opciones.almacen;
  const ahora = opciones.ahora ?? Date.now();
  const huella = JSON.stringify(correo);
  const todos = leer(almacen);
  const anterior = todos[idPedido];
  if (anterior?.huella === huella && ahora - anterior.desde <= CADUCA_MS) return anterior.id;
  const id = (opciones.nuevoId ?? (() => crypto.randomUUID()))();
  todos[idPedido] = { huella, id, desde: ahora };
  escribir(almacen, todos, ahora);
  return id;
}

/** El envío del pedido terminó bien: su clave ya no sirve para reintentarlo. */
export function envioTerminado(idPedido: string, opciones: Pick<Opciones, "almacen" | "ahora"> = {}): void {
  const almacen = opciones.almacen === undefined ? almacenDeLaApp() : opciones.almacen;
  const todos = leer(almacen);
  delete todos[idPedido];
  escribir(almacen, todos, opciones.ahora ?? Date.now());
}
