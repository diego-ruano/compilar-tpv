// test/replicableComoLaMain.test.ts
//
// AUD-36 · Lo que la Main puede mandar por el socket, igual aquí que en la Main.
//
// El TenantHub rechaza (permanente) una sentencia del lote de la Main que no tenga la forma de lo que
// captura `WriteGuard` (`tenantHub.replicable.ts`), y la Main vigila lo mismo al capturar
// (`db.rs::no_la_admite_la_nube`). Si los dos lados no dijeran lo mismo, una escritura legítima de la
// Main acabaría apartada en el equipo del cliente. Los dos leen `replicable_casos.json`.

import { describe, expect, it } from "vitest";

import casosJson from "../../../crates/tpv-infra-sqlite/src/replicable_casos.json?raw";
import { exigirOperacionDeLaMain, motivoNoReplicable } from "../src/durableObjects/tenantHub.replicable";

type Caso = { nombre: string; sql: string; motivo: string | null };
const { casos } = JSON.parse(casosJson) as { casos: Caso[] };

describe("AUD-36 · la sentencia replicable, como en la Main", () => {
	it.each(casos)("$nombre", ({ sql, motivo }) => {
		expect(motivoNoReplicable(sql)).toBe(motivo);
	});
});

describe("AUD-36 · la operación del lote de la Main", () => {
	const op = (steps: unknown[]) => ({ type: "tenantDb.transaction", payload: { steps } }) as any;

	it("una transacción de pasos execute replicables pasa", () => {
		expect(() =>
			exigirOperacionDeLaMain(op([{ kind: "execute", sql: "INSERT INTO Zonas (ID_Zona) VALUES (?1);", args: ["z"] }])),
		).not.toThrow();
	});

	it("lo que la Main no manda nunca es sentencia_no_admitida", () => {
		for (const cmd of [
			{ type: "tenantDb.exec", payload: { sql: "INSERT INTO Zonas (ID_Zona) VALUES ('z');" } },
			op([{ kind: "value", sql: "SELECT ?1", args: [1], saveAs: "x" }]),
			op([{ kind: "rows", sql: "SELECT * FROM Usuarios", args: [], saveAs: "x" }]),
			op([{ kind: "guard", sql: "SELECT 1", args: [], error: "x", status: 409 }]),
			op([{ kind: "execute", sql: "CREATE TABLE Relleno (x BLOB);", args: [] }]),
		] as any[]) {
			expect(() => exigirOperacionDeLaMain(cmd), JSON.stringify(cmd)).toThrow("sentencia_no_admitida");
		}
	});
});
