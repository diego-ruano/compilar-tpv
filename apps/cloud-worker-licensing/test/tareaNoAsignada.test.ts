// test/tareaNoAsignada.test.ts
//
// INC-20261030-010: finalizar desde la Handy una tarea que no está asignada a quien la finaliza no
// cambia ninguna fila, y `POST /v1/tareas/:id/finalizar` la daba por buena: la pantalla se cerraba
// como si se hubiera hecho. Ahora la ruta lo comprueba antes, como la Main (`tests_finalizar` en
// `tareas.rs`), y lo rechaza con `tarea_no_asignada`.

import { describe, expect, it } from "vitest";

import { clienteLocal } from "../src/durableObjects/tenantHub.sqlite";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";
import { MENSAJES } from "../src/lib/errorCodes";
import { estaAsignada } from "../src/domains/tareas/tareas.queries";

const ADMIN = "00000000-0000-7000-8000-000000000001";

describe("finalizar una tarea exige tenerla asignada", () => {
	it("sólo cuenta la asignación de ese trabajador a esa tarea", async () => {
		await enElHub("tarea-no-asignada", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			sql.exec(
				`INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre, Estado)
				 VALUES ('u1', ?, 'u1@bar.test', 'x', 'Ana', 'Activo'), ('u2', ?, 'u2@bar.test', 'x', 'Luis', 'Activo');`,
				ADMIN,
				ADMIN,
			);
			sql.exec("INSERT INTO Trabajadores (ID_Trabajador, ID_Usuario) VALUES ('ana', 'u1'), ('luis', 'u2');");
			sql.exec("INSERT INTO Tareas (ID_Tarea, Titulo, Fecha_Creacion) VALUES ('tarea', 'Limpiar', '2026-10-30 10:00:00');");
			sql.exec("INSERT INTO Tarea_Asignaciones (ID_Tarea, ID_Trabajador, Asignada_At) VALUES ('tarea', 'ana', '2026-10-30 10:00:00');");
			const db = clienteLocal(hub.state.storage);

			expect(await estaAsignada(db, "tarea", "ana")).toBe(true);
			expect(await estaAsignada(db, "tarea", "luis")).toBe(false);
			expect(await estaAsignada(db, "otra", "ana")).toBe(false);
		});
	});

	it("el rechazo dice lo mismo que la Main", () => {
		// El texto de `MSG_TAREA_NO_ASIGNADA` en `crates/tpv-infra-sqlite/src/tareas.rs`.
		expect(MENSAJES.tarea_no_asignada).toBe("Esa tarea ya no está asignada a ti. Actualiza la lista.");
	});
});
