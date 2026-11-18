// apps/tpv-main/test/permisosDeLaSesion.test.ts
//
// Qué hace la aplicación con la lectura de los permisos de la sesión (`App.tsx`).
//
// Antes, cualquier fallo de esa lectura sustituía la aplicación entera por una pantalla de error, y
// pasaba al recuperar la red en Android (la relectura al volver a primer plano): se desmontaba lo
// que hubiera abierto. Y a un usuario desactivado con la sesión abierta se le decía «No tienes
// permiso para esta acción», sin salida.

import { describe, expect, it } from "vitest";

import { estadoPermisos, motivoDeCierre, MSG_SESION_NO_VALIDA } from "../src/shared/lib/permisos";

const sinRed = { code: "external", message: "No hay conexión" };
const inactivo = { code: "usuario_inactivo", message: "Tu usuario ya no está activo. Habla con un administrador." };
const sinSesion = { code: "permiso_denegado", message: "Inicia sesión para hacer esto" };

describe("los permisos de la sesión", () => {
	it("mientras no han contestado nunca, se espera sin pintar nada", () => {
		expect(estadoPermisos({ isError: false, error: null, hayDatos: false })).toBe("esperar");
	});

	it("leídos, se trabaja", () => {
		expect(estadoPermisos({ isError: false, error: null, hayDatos: true })).toBe("trabajar");
	});

	it("si una relectura falla con permisos ya leídos, se sigue trabajando con ellos", () => {
		expect(estadoPermisos({ isError: true, error: sinRed, hayDatos: true })).toBe("trabajar");
	});

	it("si no se han podido leer nunca, la pantalla de error", () => {
		expect(estadoPermisos({ isError: true, error: sinRed, hayDatos: false })).toBe("sin_permisos");
	});

	it("si el usuario ya no está activo, se cierra la sesión, tuviera permisos leídos o no", () => {
		expect(estadoPermisos({ isError: true, error: inactivo, hayDatos: true })).toBe("cerrar_sesion");
		expect(estadoPermisos({ isError: true, error: inactivo, hayDatos: false })).toBe("cerrar_sesion");
		expect(motivoDeCierre(inactivo, inactivo.message)).toBe(inactivo.message);
	});

	it("si el backend ya no reconoce la sesión, se cierra en vez de seguir con los permisos viejos", () => {
		// Antes se seguía pintando con los últimos leídos y se reintentaba cada 15 s para siempre.
		expect(estadoPermisos({ isError: true, error: sinSesion, hayDatos: true })).toBe("cerrar_sesion");
		expect(estadoPermisos({ isError: true, error: sinSesion, hayDatos: false })).toBe("cerrar_sesion");
		// El login no dice «Inicia sesión para hacer esto», que es para quien intenta una acción.
		expect(motivoDeCierre(sinSesion, sinSesion.message)).toBe(MSG_SESION_NO_VALIDA);
	});
});
