// test/sinPin.test.ts
//
// `Usuarios.Sin_PIN`: quien entra sin PIN. El alta lo guarda, la edición lo cambia sólo si llega
// (`COALESCE`, como la Main) y la consulta del login lo devuelve como booleano, que es lo que
// deserializa la Main. Que la ruta no compruebe el PIN de ese usuario y sí el de los demás, con el
// freno delante, lo fija `pinSiempreConFreno.test.ts` leyendo el fuente.

import { describe, expect, it } from "vitest";

import * as cmd from "../src/domains/trabajadores/trabajadores.commands";
import {
	trabajadorCreateSchema,
	trabajadorUpdateSchema,
} from "../src/domains/trabajadores/trabajadores.schemas";
import { getLoginRecord, listLoginUsers } from "../src/domains/login/login.queries";
import { loginUserSchema, punchSchema } from "../src/domains/login/login.schemas";
import { clienteSobre } from "./helpers/clienteSql";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";

const ALTA = { id_rol: "rol-1", email: "ada@test.local", pin: "4321", nombre: "Ada", estado: "Activo" };
const EDICION = { ...ALTA, id_trabajador: "trab-1", id_usuario: "user-1" };

describe("Sin_PIN · entrar sin PIN", () => {
	it("el alta pide PIN si no se dice otra cosa; la edición sólo lo cambia si llega", () => {
		expect(trabajadorCreateSchema.parse(ALTA).sin_pin).toBe(false);
		expect(trabajadorCreateSchema.parse({ ...ALTA, sin_pin: true }).sin_pin).toBe(true);
		expect(trabajadorUpdateSchema.parse(EDICION).sin_pin).toBeNull();
		expect(trabajadorUpdateSchema.parse({ ...EDICION, sin_pin: false }).sin_pin).toBe(false);
	});

	it("el login y el fichaje aceptan un PIN vacío: lo decide la ruta según el usuario", () => {
		expect(loginUserSchema.safeParse({ id_usuario: "user-1", pin: "" }).success).toBe(true);
		expect(punchSchema.safeParse({ id_usuario: "user-1", pin: "", tipo: "entrada" }).success).toBe(true);
	});

	it("la edición conserva Sin_PIN cuando no llega y lo cambia cuando llega", async () => {
		await enElHub("sin-pin-edicion", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			sql.exec(
				"INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre, Sin_PIN) VALUES ('user-1', (SELECT ID_Rol FROM Roles WHERE Nombre_Rol = 'Camarero'), 'ada@test.local', 'h', 'Ada', 1);",
			);
			const camarero = sql.exec("SELECT ID_Rol AS r FROM Roles WHERE Nombre_Rol = 'Camarero';").one().r;
			const editar = (cambios: Record<string, unknown>) => {
				const input = trabajadorUpdateSchema.parse({ ...EDICION, id_rol: camarero, ...cambios }) as any;
				const paso = cmd
					.updateTrabajador("trab-1", input, null)
					.command.payload.steps.find((s: any) => s.kind === "execute" && s.sql.includes("UPDATE Usuarios"));
				sql.exec(paso.sql, ...paso.args);
				return sql.exec("SELECT Sin_PIN AS s FROM Usuarios WHERE ID_Usuario = 'user-1';").one().s;
			};
			expect(editar({})).toBe(1);
			expect(editar({ sin_pin: false })).toBe(0);
			expect(editar({ sin_pin: true })).toBe(1);
		});
	});

	it("la consulta del login lo devuelve como booleano", async () => {
		await enElHub("sin-pin-login", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			sql.exec(
				"INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre, Sin_PIN) VALUES ('user-1', (SELECT ID_Rol FROM Roles WHERE Nombre_Rol = 'Camarero'), 'ada@test.local', 'h', 'Ada', 1);",
			);
			const db = clienteSobre(sql) as any;
			expect(Number((await getLoginRecord(db, "user-1")).sin_pin)).toBe(1);
			const lista = await listLoginUsers(db);
			expect(lista.find((u) => u.id_usuario === "user-1")?.sin_pin).toBe(true);
		});
	});
});
