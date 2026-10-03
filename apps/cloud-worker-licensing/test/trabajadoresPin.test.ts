// test/trabajadoresPin.test.ts
//
// RI-63: el alta y la edición de un trabajador reciben el PIN, no su hash. La ruta lo hashea con
// `hashPin`, así que no se guarda un hash hecho fuera (con las iteraciones que sea), y el PIN tiene
// que poder teclearse en el login: de 4 a 6 cifras, como `pin_de_teclado` en la Main.

import { describe, expect, it } from "vitest";

import * as cmd from "../src/domains/trabajadores/trabajadores.commands";
import {
	trabajadorCreateSchema,
	trabajadorUpdateSchema,
} from "../src/domains/trabajadores/trabajadores.schemas";

const ALTA = {
	id_rol: "rol-1",
	email: "ada@test.local",
	pin: "4321",
	nombre: "Ada",
	estado: "Activo",
};

const EDICION = { ...ALTA, id_trabajador: "trab-1", id_usuario: "user-1" };

describe("RI-63 · el PIN del personal", () => {
	it("se acepta de 4 a 6 cifras, y nada que no se pueda teclear en el login", () => {
		for (const pin of ["1234", "123456", " 0000 "]) {
			expect(trabajadorCreateSchema.safeParse({ ...ALTA, pin }).success, pin).toBe(true);
		}
		for (const pin of ["", "123", "1234567", "12a4", "12 34"]) {
			expect(trabajadorCreateSchema.safeParse({ ...ALTA, pin }).success, pin).toBe(false);
		}
	});

	it("en la edición es opcional: vacío o ausente no cambia el PIN", () => {
		expect(trabajadorUpdateSchema.parse({ ...EDICION, pin: "" }).pin).toBeNull();
		expect(trabajadorUpdateSchema.parse({ ...EDICION, pin: undefined }).pin).toBeNull();
		expect(trabajadorUpdateSchema.safeParse({ ...EDICION, pin: "1234567" }).success).toBe(false);
	});

	it("el PIN no se queda en la cola del Durable Object; el hash es el que hizo la ruta", () => {
		const alta = cmd.createTrabajador(trabajadorCreateSchema.parse(ALTA) as any, "HASH-DE-LA-RUTA");
		expect(JSON.stringify(alta.cloudPayload)).not.toContain("4321");
		expect(JSON.stringify(alta.command)).not.toContain("4321");
		expect(JSON.stringify(alta.command)).toContain("HASH-DE-LA-RUTA");

		const edicion = cmd.updateTrabajador(
			"trab-1",
			trabajadorUpdateSchema.parse(EDICION) as any,
			"HASH-DE-LA-RUTA",
		);
		expect(JSON.stringify(edicion.cloudPayload)).not.toContain("4321");
		expect(JSON.stringify(edicion.command)).not.toContain("4321");
		expect(JSON.stringify(edicion.command)).toContain("Password_Hash");
	});

	it("sin PIN nuevo, la edición no toca el hash", () => {
		const edicion = cmd.updateTrabajador(
			"trab-1",
			trabajadorUpdateSchema.parse({ ...EDICION, pin: null }) as any,
			null,
		);
		expect(JSON.stringify(edicion.command)).not.toContain("Password_Hash");
	});
});
