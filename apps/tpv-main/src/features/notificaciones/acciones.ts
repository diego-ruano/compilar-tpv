// src/features/notificaciones/acciones.ts
//
// Traduce la `accion` de una notificación a la pantalla que resuelve el aviso. La acción la fija
// el emisor en Rust (`use_cases/*`: "ver_tareas", "ver_reservas", "ver_pedidos", "ver_licencia",
// "ver_inventario", "ver_clientes", "ver_fiscal"); aquí solo se mapea a una ruta del router.
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
  // FISCAL-01: atraso en la remisión a la AEAT. Lleva a la pantalla donde se ve la cola, el
  // certificado y el botón de probar la conexión, que es donde se resuelve.
  ver_fiscal: { to: "/Configuracion", state: { seccion: "FISCAL" } },
};

export function destinoDeAccion(
  accion: string | null | undefined,
): DestinoNotificacion | null {
  if (!accion) return null;
  return DESTINOS[accion] ?? null;
}
