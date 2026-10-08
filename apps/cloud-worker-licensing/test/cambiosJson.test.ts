import { describe, expect, it } from "vitest";
import { serializarCambios, type CambioGuardado } from "../src/domains/sync/cambiosJson";
import { enElHub } from "./helpers/hub";

describe("RI-44 · catch-up sin doble serialización", () => {
	it("conserva sentencias y escapa los metadatos sin cambiar los checkpoints", async () => {
		await enElHub("ri44-json", async (hub: any) => {
			const raw = '[{"sql":"UPDATE Productos SET Nombre=?","args":["Bar \\\"Plaza\\\""]}]';
			const [{ tipo }] = [...hub.state.storage.sql.exec("SELECT CASE WHEN json_valid(?) THEN json_type(?) ELSE 'invalid' END AS tipo", raw, raw)];
			const row: CambioGuardado = { Seq: 10, Op_Id: 'op"id', Command_Name: "actualizar", Device_Id: null, Created_At_Ms: 1000, Statements_Json: raw, Statements_Type: tipo };
			const response = JSON.parse(serializarCambios([row], 9, 20));
			expect(response.items[0].statements).toEqual(JSON.parse(raw));
			expect(response.items[0].opId).toBe('op"id');
			expect(response.nextSince).toBe(10);
			expect(response.highWater).toBe(20);
		});
	});
	it("no convierte un registro corrupto en una operación vacía", () => {
		for (const tipo of ["invalid", "object", "null"]) {
			expect(() => serializarCambios([{ Statements_Type: tipo } as CambioGuardado], 9, 20)).toThrow("sync_log_corrupto");
		}
		expect(JSON.parse(serializarCambios([], 9, 20))).toMatchObject({ items: [], nextSince: 9, highWater: 20 });
	});
});
