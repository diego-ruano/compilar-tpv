// test/usuarioInactivo.test.ts
//
// Un administrador desactiva a un camarero con su sesión abierta en una Handy. Lo siguiente que la
// Handy pregunta son los permisos de esa sesión (`GET /v1/trabajadores/permisos/:id`): antes la
// respuesta era `null`, que el cliente convertía en «No tienes permiso para esta acción», y la
// pantalla se quedaba en un error sin salida. Ahora es `usuario_inactivo`, con el mismo texto que la
// Main (`tpv_contracts::errors::USUARIO_INACTIVO`), y la pantalla cierra la sesión.
//
// Por el camino desplegado: `tenantAuth`, `alHub` y la ruta dentro del TenantHub.

import { describe, expect, it } from "vitest";

import { HANDY, conNegocioFirmado, enLaBaseDe, pedirComo } from "./helpers/negocioFirmado";
import { app } from "../src/app";
import { firmarSesion } from "../src/lib/sesion";
import { olvidarLicenciasCacheadas } from "../src/lib/licenciaEnUso";

const deps = { firmarSesion, olvidarLicenciasCacheadas };

const CAMARERO = "0192f7a4-3b1c-7d2e-8f00-00000000ca01";
const ROL_CAMARERO = "00000000-0000-7000-8000-000000000002";

describe("los permisos de un usuario desactivado con la sesión abierta", () => {
	it("dicen que ya no está activo, con su código y el texto de la Main", async () => {
		await conNegocioFirmado(deps, "usuario-inactivo", async (n) => {
			await enLaBaseDe(n, (sql) => {
				sql.exec(
					"INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre) VALUES (?, ?, 'c@bar.test', 'x', 'Camarero');",
					CAMARERO,
					ROL_CAMARERO,
				);
			});

			const activo = await pedirComo(deps, app, n, HANDY, "GET", `/v1/trabajadores/permisos/${CAMARERO}`);
			expect(activo.status).toBe(200);
			expect(activo.json).toMatchObject({ rol: "Camarero" });

			await enLaBaseDe(n, (sql) => {
				sql.exec("UPDATE Usuarios SET Estado = 'Inactivo' WHERE ID_Usuario = ?;", CAMARERO);
			});
			const inactivo = await pedirComo(deps, app, n, HANDY, "GET", `/v1/trabajadores/permisos/${CAMARERO}`);
			expect(inactivo.status).toBe(403);
			expect(inactivo.json).toMatchObject({
				code: "usuario_inactivo",
				message: "Tu usuario ya no está activo. Habla con un administrador.",
			});

			// El que no existe sigue sin autorización, como antes.
			const nadie = await pedirComo(deps, app, n, HANDY, "GET", "/v1/trabajadores/permisos/0192f7a4-3b1c-7d2e-8f00-00000000ffff");
			expect(nadie.status).toBe(200);
			expect(nadie.json).toBeNull();
		});
	});
});
