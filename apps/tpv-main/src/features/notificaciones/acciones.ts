// src/features/notificaciones/acciones.ts
//
// Traduce la `accion` de una notificación a la pantalla que resuelve el aviso. La acción la fija
// el emisor en Rust (`use_cases/*`: "ver_tareas", "ver_reservas", "ver_pedidos", "ver_licencia",
// "ver_inventario", "ver_clientes", "ver_fiscal", "ver_conectividad"); aquí solo se mapea a una ruta
// del router.
//
// Una acción desconocida devuelve `null`: la notificación se marca como leída y no navega. Así el
// backend puede emitir acciones nuevas (o una versión vieja del front recibir una acción reciente)
// sin romper la pantalla.

import type { SectionKey } from "../configuracion/types";

export type DestinoNotificacion = {
  /** Ruta del router a la que navegar. */
  to: string;
  /** Estado de navegación; lo usa Configuración para abrir una sección concreta. */
  state?: { seccion: SectionKey };
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
  // FISCAL-01: lleva a los datos fiscales del negocio. Lo llevan también los avisos de envío a la
  // AEAT que se hubieran creado con la rama `con-verifactu`.
  ver_fiscal: { to: "/Configuracion", state: { seccion: "NEGOCIO" } },
  // SYNC-36: un cambio de la nube atascado en su cuarentena. Conectividad explica qué pasa y ofrece
  // traer el estado actual de la nube cuando es seguro.
  ver_conectividad: { to: "/Configuracion", state: { seccion: "CONECTIVIDAD" } },
};

export function destinoDeAccion(
  accion: string | null | undefined,
): DestinoNotificacion | null {
  if (!accion) return null;
  return DESTINOS[accion] ?? null;
}
