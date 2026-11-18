// shared/lib/permisos.ts
//
// Los roles, en un solo sitio, y qué hace la UI cuando el backend dice que no (SEC-01).
//
// El candado de verdad vive en los comandos Tauri: es el único que no se esquiva escribiendo
// una URL o abriendo las DevTools. Lo de aquí es la otra mitad del trato — que la interfaz no
// ofrezca lo que no corresponde— más un mensaje entendible para cuando aun así se llega.
//
// Que el nombre del rol estuviera escrito a mano en cinco pantallas era el motivo de que la
// NavBar, la ruta y el backend pudieran discrepar sin que nadie se enterase.

import { esError } from "@tpv/client";

/** El rol privilegiado. Espejo de `ADMIN` en `apps/tpv-main/src-tauri/src/lib.rs`. */
export const ROL_ADMIN = "Administrador";

/** Espejo de `CAMARERO` en `apps/tpv-main/src-tauri/src/lib.rs`. */
export const ROL_CAMARERO = "Camarero";

export function esAdmin(role: string | null | undefined): boolean {
    return role === ROL_ADMIN;
}

/**
 * ¿Entra en Cuentas? El administrador, entero; el camarero, sólo a los cobros y sus bajas
 * (reimprimir, devolver, dar de baja un error), que es lo que pasa a mitad de servicio sin el
 * encargado delante. Gastos, cierre de caja, facturas con NIF y exportar siguen siendo del
 * administrador.
 */
export function entraEnCuentas(role: string | null | undefined): boolean {
    return role === ROL_ADMIN || role === ROL_CAMARERO;
}

/**
 * ¿El backend ha rechazado esto por permisos?
 *
 * Se ramifica por el código, nunca por el texto (ARCH-05). Sirve para enseñar "no tienes
 * permiso" en vez del "no se pudieron cargar los datos" genérico, que es el mensaje que hace
 * que alguien reintente diez veces algo que nunca va a funcionar.
 */
export function esPermisoDenegado(e: unknown): boolean {
    return esError(e, "permiso_denegado");
}

/**
 * Qué hace la aplicación con la lectura de los permisos de la sesión:
 *
 * - `esperar`: todavía no ha contestado nunca. No se pinta nada (es casi instantáneo, y un
 *   «Cargando permisos…» sólo parpadearía).
 * - `cerrar_sesion`: el usuario ya no está activo (lo desactivaron con la sesión abierta). Se
 *   cierra, y el login dice por qué.
 * - `sin_permisos`: no se han podido leer nunca. Sin ellos no se sabe qué enseñar: la pantalla de
 *   error, con reintentar y cerrar sesión.
 * - `trabajar`: hay permisos que usar. También si la última relectura ha fallado (sin red, la
 *   Handy al recuperarla): se sigue con los últimos leídos, porque quien decide es el backend en
 *   cada comando, y desmontar la aplicación se llevaba por delante lo que hubiera abierto.
 */
export type EstadoPermisos = "esperar" | "cerrar_sesion" | "sin_permisos" | "trabajar";

export function estadoPermisos(q: { isError: boolean; error: unknown; hayDatos: boolean }): EstadoPermisos {
    if (q.isError && esError(q.error, "usuario_inactivo")) return "cerrar_sesion";
    if (q.hayDatos) return "trabajar";
    if (q.isError) return "sin_permisos";
    return "esperar";
}
