// apps/tpv-main/test/permisosDeLaSesion.test.ts
//
// Qué hace la aplicación con la lectura de los permisos de la sesión (`App.tsx`).
//
// Antes, cualquier fallo de esa lectura sustituía la aplicación entera por una pantalla de error, y
// pasaba al recuperar la red en Android (la relectura al volver a primer plano): se desmontaba lo
// que hubiera abierto. Y a un usuario desactivado con la sesión abierta se le decía «No tienes
// permiso para esta acción», sin salida.

import { describe, expect, it } from "vitest";

import { estadoPermisos } from "../src/shared/lib/permisos";

const sinRed = { code: "external", message: "No hay conexión" };
const inactivo = { code: "usuario_inactivo", message: "Tu usuario ya no está activo. Habla con un administrador." };

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
	});
});
