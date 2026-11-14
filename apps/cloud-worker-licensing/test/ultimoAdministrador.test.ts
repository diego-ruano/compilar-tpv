// test/ultimoAdministrador.test.ts
//
// RI-62: editar una ficha desde la Handy no puede dejar el negocio sin ningún administrador
// activo. Es la guarda de `updateTrabajador`, que se evalúa dentro del lote que escribe (SYNC-30);
// la Main hace la misma comprobación, con la misma condición, dentro de su transacción
// (`tests_edicion` en `trabajadores.rs`). Aquí se evalúa la guarda sola, sobre cada caso.

import { describe, expect, it } from "vitest";

import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";
import { updateTrabajador } from "../src/domains/trabajadores/trabajadores.commands";

/**
 * ¿La edición de `idUsuario` con ese rol y ese estado dejaría el negocio sin administrador? Es que su
 * guarda (`ultimo_administrador`) no se cumple.
 */
function dejariaSinAdministrador(sql: any, idUsuario: string, idRolNuevo: string, estadoNuevo: string): boolean {
	const input = { id_usuario: idUsuario, id_rol: idRolNuevo, estado: estadoNuevo } as any;
	const guarda = updateTrabajador("trab", input, null).command.payload.steps.find(
		(p: any) => p.kind === "guard" && p.error === "ultimo_administrador",
	);
	const valor = Object.values(sql.exec(guarda.sql, ...guarda.args).toArray()[0] ?? {})[0];
	return Number(valor) === 0;
}

const ADMIN = "00000000-0000-7000-8000-000000000001";
const CAMARERO = "00000000-0000-7000-8000-000000000002";

/** Un tenant con los usuarios dados: `[id, rol, estado]`. */
async function conUsuarios(
	nombre: string,
	usuarios: [string, string, string][],
	prueba: (sql: any) => Promise<void>,
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
		await prueba(sqlStorage);
	});
}

describe("no se puede dejar el negocio sin administrador", () => {
	it("el único administrador no puede quitarse el rol ni desactivarse", async () => {
		await conUsuarios("ultimo-admin-solo", [["ana", ADMIN, "Activo"]], async (sql) => {
			expect(dejariaSinAdministrador(sql, "ana", CAMARERO, "Activo")).toBe(true);
			expect(dejariaSinAdministrador(sql, "ana", ADMIN, "Inactivo")).toBe(true);
			// Editarle lo demás sí.
			expect(dejariaSinAdministrador(sql, "ana", ADMIN, "Activo")).toBe(false);
		});
	});

	it("con otro administrador activo, sí", async () => {
		await conUsuarios(
			"ultimo-admin-otro",
			[
				["ana", ADMIN, "Activo"],
				["luis", ADMIN, "Activo"],
			],
			async (sql) => {
				expect(dejariaSinAdministrador(sql, "ana", CAMARERO, "Activo")).toBe(false);
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
			async (sql) => {
				expect(dejariaSinAdministrador(sql, "ana", ADMIN, "Inactivo")).toBe(true);
			},
		);
	});

	it("sin administradores de partida, editar a otro no se bloquea", async () => {
		await conUsuarios("ultimo-admin-ninguno", [["pepe", CAMARERO, "Activo"]], async (sql) => {
			expect(dejariaSinAdministrador(sql, "pepe", CAMARERO, "Inactivo")).toBe(false);
		});
	});
});
