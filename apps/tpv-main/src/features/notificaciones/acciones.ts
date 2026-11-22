// src/features/notificaciones/acciones.ts
//
// Traduce la `accion` de una notificación a la pantalla que resuelve el aviso. La acción la fija
// el emisor en Rust (`use_cases/*`: "ver_tareas", "ver_reservas", "ver_pedidos", "ver_licencia",
// "ver_inventario", "ver_clientes", "ver_proveedores", "ver_fiscal", "ver_conectividad"); aquí solo
// se mapea a una ruta del router.
//
// Una acción desconocida devuelve `null`: la notificación se marca como leída y no navega. Así el
// backend puede emitir acciones nuevas (o una versión vieja del front recibir una acción reciente)
// sin romper la pantalla.

import type { SectionKey } from "../configuracion/types";
import { reservaAvisada, type ReservaAvisada } from "../reservas/calendario";

export type DestinoNotificacion = {
  /** Ruta del router a la que navegar. */
  to: string;
  /** Estado de navegación: la sección que abre Configuración, o la reserva que Reservas abre en su
   *  día y señala. */
  state?: { seccion: SectionKey } | { reserva: ReservaAvisada };
};

const DESTINOS: Record<string, DestinoNotificacion> = {
  ver_tareas: { to: "/Tareas" },
  ver_reservas: { to: "/Reservas" },
  // Los pedidos a proveedor se gestionan dentro de la pantalla de Proveedores (PedidosSection).
  ver_pedidos: { to: "/Proveedores" },
  ver_licencia: { to: "/Configuracion", state: { seccion: "LICENCIA" } },
  // Descuadres que detecta el job de reconciliación: llevan a la pantalla donde se corrigen
  // (ajustar el lote / revisar la ficha del cliente).
  ver_inventario: { to: "/Inventario" },
  ver_clientes: { to: "/Clientes" },
  // SYN-INC-07: dos fichas distintas con el mismo correo o CIF, que hay que resolver a mano.
  ver_proveedores: { to: "/Proveedores" },
  // FISCAL-01: lleva a los datos fiscales del negocio. Lo llevan también los avisos de envío a la
  // AEAT que se hubieran creado con la rama `con-verifactu`.
  ver_fiscal: { to: "/Configuracion", state: { seccion: "NEGOCIO" } },
  // SYNC-36: un cambio de la nube atascado en su cuarentena. Conectividad explica qué pasa y ofrece
  // traer el estado actual de la nube cuando es seguro. No está en el menú: sólo se llega por aquí.
  ver_conectividad: { to: "/Configuracion", state: { seccion: "CONECTIVIDAD" } },
};

/**
 * El destino de una notificación. La de una reserva (`ver_reservas`) lleva en su `payload` qué reserva
 * es y de qué día (`{id_reserva, dia_ymd}`, `use_cases/reservas.rs::payload_del_aviso`): Reservas abre
 * ese día y la señala. Sin `payload`, o con uno que no vale, abre en hoy, como antes.
 */
export function destinoDeAccion(
  accion: string | null | undefined,
  payload?: string | null,
): DestinoNotificacion | null {
  if (!accion) return null;
  const destino = DESTINOS[accion] ?? null;
  if (destino && accion === "ver_reservas") {
    const reserva = reservaDelPayload(payload);
    if (reserva) return { ...destino, state: { reserva } };
  }
  return destino;
}

function reservaDelPayload(payload: string | null | undefined): ReservaAvisada | null {
  if (!payload) return null;
  let leido: unknown;
  try {
    leido = JSON.parse(payload);
  } catch {
    return null;
  }
  const r = reservaAvisada({ reserva: leido });
  return r ? { id_reserva: r.id_reserva, dia_ymd: r.dia_ymd } : null;
}
