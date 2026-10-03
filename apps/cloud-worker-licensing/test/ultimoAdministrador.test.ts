// test/ultimoAdministrador.test.ts
//
// RI-62: editar una ficha desde la Handy no puede dejar el negocio sin ningún administrador
// activo. Es la comprobación previa de `PUT /v1/trabajadores/:id`; la Main hace la misma, con el
// mismo SQL, dentro de su transacción (`tests_edicion` en `trabajadores.rs`).

import { describe, expect, it } from "vitest";

import { clienteSobre } from "./helpers/clienteSql";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";
import { dejariaSinAdministrador } from "../src/domains/trabajadores/trabajadores.queries";

const ADMIN = "00000000-0000-7000-8000-000000000001";
const CAMARERO = "00000000-0000-7000-8000-000000000002";

/** Un tenant con los usuarios dados: `[id, rol, estado]`. */
async function conUsuarios(
	nombre: string,
	usuarios: [string, string, string][],
	prueba: (db: any) => Promise<void>,
) {
	await enElHub(nombre, async (hub: any) => {
		const sqlStorage = hub.state.storage.sql;
		crearEsquemaTenant(sqlStorage);
		for (const [id, rol, estado] of usuarios) {
			sqlStorage.exec(
				`INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre, Estado)
				 VALUES (?, ?, ?, 'x', 'Nombre', ?);`,
				id,
				rol,
				`${id}@bar.test`,
				estado,
			);
		}
		await prueba(clienteSobre(sqlStorage));
	});
}

describe("no se puede dejar el negocio sin administrador", () => {
	it("el único administrador no puede quitarse el rol ni desactivarse", async () => {
		await conUsuarios("ultimo-admin-solo", [["ana", ADMIN, "Activo"]], async (db) => {
			expect(await dejariaSinAdministrador(db, "ana", CAMARERO, "Activo")).toBe(true);
			expect(await dejariaSinAdministrador(db, "ana", ADMIN, "Inactivo")).toBe(true);
			// Editarle lo demás sí.
			expect(await dejariaSinAdministrador(db, "ana", ADMIN, "Activo")).toBe(false);
		});
	});

	it("con otro administrador activo, sí", async () => {
		await conUsuarios(
			"ultimo-admin-otro",
			[
				["ana", ADMIN, "Activo"],
				["luis", ADMIN, "Activo"],
			],
			async (db) => {
				expect(await dejariaSinAdministrador(db, "ana", CAMARERO, "Activo")).toBe(false);
			},
		);
	});

	it("un administrador inactivo no cuenta como el otro", async () => {
		await conUsuarios(
			"ultimo-admin-inactivo",
			[
				["ana", ADMIN, "Activo"],
				["luis", ADMIN, "Inactivo"],
			],
			async (db) => {
				expect(await dejariaSinAdministrador(db, "ana", ADMIN, "Inactivo")).toBe(true);
			},
		);
	});

	it("sin administradores de partida, editar a otro no se bloquea", async () => {
		await conUsuarios("ultimo-admin-ninguno", [["pepe", CAMARERO, "Activo"]], async (db) => {
			expect(await dejariaSinAdministrador(db, "pepe", CAMARERO, "Inactivo")).toBe(false);
		});
	});
});
