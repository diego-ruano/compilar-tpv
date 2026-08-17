// test/trabajadoresPii.test.ts
//
// TRAB-03: la Handy escribe por REST contra el worker, y el worker NO tiene la clave de
// cifrado. Si sus sentencias tocaran DNI, IBAN o el nº de la Seguridad Social, esos valores
// acabarían en claro en Turso — justo lo que el cifrado de la Main evita.
//
// Estos tests fijan esa frontera. Son de construcción de comandos (funciones puras): no hace
// falta ni base de datos ni red.

import { describe, it, expect } from "vitest";

import * as cmd from "../src/domains/trabajadores/trabajadores.commands";
import {
	trabajadorCreateSchema,
	trabajadorUpdateSchema,
} from "../src/domains/trabajadores/trabajadores.schemas";

const PII = ["DNI", "IBAN", "Numero_Seguridad_Social"];

/** Todo el SQL de un comando, concatenado, para poder buscar columnas en él. */
function sqlDe(built: { command: { payload: any } }): string {
	const steps = built.command.payload.steps ?? [];
	return steps.map((s: any) => String(s.sql ?? "")).join("\n");
}

/** Todos los args de un comando, aplanados a texto. */
function argsDe(built: { command: { payload: any } }): string[] {
	const steps = built.command.payload.steps ?? [];
	return steps.flatMap((s: any) => (s.args ?? []).map((a: any) => JSON.stringify(a)));
}

const ALTA = {
	id_rol: "rol-1",
	email: "ada@test.local",
	password_hash: "hash",
	nombre: "Ada",
	apellido: "Lovelace",
	estado: "Activo",
	telefono: "600000000",
	puesto: "Camarera",
	fecha_inicio_contrato: null,
	fecha_fin_contrato: null,
};

describe("TRAB-03 · el worker no toca la PII cifrada", () => {
	it("el alta no escribe ninguna de las tres columnas", () => {
		const built = cmd.createTrabajador(trabajadorCreateSchema.parse(ALTA) as any);
		const sql = sqlDe(built);

		for (const col of PII) {
			expect(sql, `el INSERT no debe mencionar ${col}`).not.toContain(col);
		}
	});

	it("la edición tampoco, y las omite en vez de ponerlas a NULL", () => {
		const built = cmd.updateTrabajador(
			"trab-1",
			trabajadorUpdateSchema.parse({
				...ALTA,
				id_trabajador: "trab-1",
				id_usuario: "user-1",
			}) as any,
		);
		const sql = sqlDe(built);

		for (const col of PII) {
			expect(sql, `el UPDATE no debe mencionar ${col}`).not.toContain(col);
		}

		// El matiz importante: omitidas, NO puestas a NULL. Si el SET las pusiera a NULL,
		// editar el teléfono desde una Handy borraría el DNI que guardó la Main.
		expect(sql).toContain("Telefono");
		expect(sql).not.toMatch(/=\s*NULL/i);
	});

	it("un cuerpo con DNI/IBAN/NSS no cuela esos valores en la sentencia", () => {
		// Un cliente antiguo (o alguien curioseando con la API) puede mandarlos igualmente.
		const conPii = {
			...ALTA,
			dni: "12345678Z",
			iban: "ES9121000418450200051332",
			numero_seguridad_social: "281234567840",
		};

		const built = cmd.createTrabajador(trabajadorCreateSchema.parse(conPii) as any);
		const args = argsDe(built).join("|");

		expect(args).not.toContain("12345678Z");
		expect(args).not.toContain("ES9121000418450200051332");
		expect(args).not.toContain("281234567840");
	});
});
