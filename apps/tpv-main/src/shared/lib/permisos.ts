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

export function esAdmin(role: string | null | undefined): boolean {
    return role === ROL_ADMIN;
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
 * - `cerrar_sesion`: el usuario ya no está activo (lo desactivaron con la sesión abierta), o el
 *   backend dice que la sesión no vale (`permiso_denegado` al leer los permisos de la propia
 *   sesión: ya no la tiene, o el usuario ya no existe). Se cierra, y el login dice por qué
 *   (`motivoDeCierre`). Seguir con los permisos viejos era trabajar con una sesión que el backend
 *   rechaza en cada comando, reintentando cada 15 s sin fin.
 * - `sin_permisos`: no se han podido leer nunca. Sin ellos no se sabe qué enseñar: la pantalla de
 *   error, con reintentar y cerrar sesión.
 * - `trabajar`: hay permisos que usar. También si la última relectura ha fallado (sin red, la
 *   Handy al recuperarla): se sigue con los últimos leídos, porque quien decide es el backend en
 *   cada comando, y desmontar la aplicación se llevaba por delante lo que hubiera abierto.
 */
export type EstadoPermisos = "esperar" | "cerrar_sesion" | "sin_permisos" | "trabajar";

export function estadoPermisos(q: { isError: boolean; error: unknown; hayDatos: boolean }): EstadoPermisos {
    if (q.isError && (esError(q.error, "usuario_inactivo") || esPermisoDenegado(q.error))) return "cerrar_sesion";
    if (q.hayDatos) return "trabajar";
    if (q.isError) return "sin_permisos";
    return "esperar";
}

/** Lo que dice el login cuando el backend ya no reconoce la sesión. */
export const MSG_SESION_NO_VALIDA = "Tu sesión ya no es válida en este equipo. Vuelve a entrar.";

/**
 * Lo que el login dice al cerrar la sesión por `cerrar_sesion`: el motivo del backend si el usuario
 * ya no está activo; si la sesión no vale, `MSG_SESION_NO_VALIDA` (el texto de `permiso_denegado` es
 * para quien intenta una acción, como «Inicia sesión para hacer esto», y no explica el cierre).
 */
export function motivoDeCierre(error: unknown, mensaje: string): string {
    return esError(error, "usuario_inactivo") ? mensaje : MSG_SESION_NO_VALIDA;
}
