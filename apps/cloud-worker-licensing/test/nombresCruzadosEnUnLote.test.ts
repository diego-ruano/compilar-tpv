// test/nombresCruzadosEnUnLote.test.ts
//
// SYNC-37 · Dos zonas con el nombre cruzado, reparadas por el contraste de la Main en un lote.
//
// En la Main `z-1=Salón z-2=Terraza`, en la nube al revés. La reparación sube cómo está cada fila
// (`INSERT … ON CONFLICT(clave) DO UPDATE`), y el TenantHub comprueba el índice único de los nombres
// de las zonas activas sentencia a sentencia: la primera chocaría con la segunda. Por eso la
// operación empieza aparcando los nombres (`aparcar.rs`), y la nube la aplica en una transacción.
// Con el motor y la base de verdad, aquí se fija que así entra entera sin dejar nada aparcado, y
// que sin aparcar no entraría.
//
// El texto de las sentencias es el que fija `aparcar.rs` en su test
// `lo_que_aparca_se_lee_como_una_escritura_de_su_fila`, y el de la escritura,
// `sync_reparacion::sentencia_de_reparacion`.

import { describe, expect, it } from "vitest";

import { enElHub } from "./helpers/hub";
import { montarMainEnElHub, opDelOutbox, type MainEnElHub } from "./helpers/mainEnElHub";

const TENANT = "tenant-nombres-cruzados";
const ALTA = "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES (?1, ?2);";

const APARCAR =
	'UPDATE "Zonas" SET "Nombre_Zona" = CASE WHEN "Nombre_Zona" IS NOT ?2 OR "Archivada_En" IS NOT ?3 THEN ?4 ' +
	'ELSE "Nombre_Zona" END WHERE "ID_Zona" = ?1 AND ("Nombre_Zona" IS NOT ?2 OR "Archivada_En" IS NOT ?3);';
const ESCRIBIR =
	'INSERT INTO "Zonas" ("ID_Zona", "Nombre_Zona", "Room_Points", "Updated_At", "Archivada_En") ' +
	"VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(\"ID_Zona\") DO UPDATE SET " +
	'"Nombre_Zona" = excluded."Nombre_Zona", "Room_Points" = excluded."Room_Points", ' +
	'"Updated_At" = excluded."Updated_At", "Archivada_En" = excluded."Archivada_En";';

/** `aparcar::valor_temporal`: la clave en JSON, en hexadecimal, tras un carácter de control. */
const temporal = (id: string): string =>
	"\u0001SYNC-37 " +
	[...new TextEncoder().encode(JSON.stringify([id]))].map((b) => b.toString(16).padStart(2, "0")).join("");

const aparcar = (id: string, nombre: string) => ({ sql: APARCAR, args: [id, nombre, null, temporal(id)] });
const escribir = (id: string, nombre: string) => ({ sql: ESCRIBIR, args: [id, nombre, "[]", null, null] });

const zonas = (sql: any): string[] =>
	sql
		.exec("SELECT ID_Zona, Nombre_Zona FROM Zonas ORDER BY ID_Zona;")
		.toArray()
		.map((f: any) => `${f.ID_Zona}=${f.Nombre_Zona}`);

async function enUnHub<T>(nombre: string, prueba: (m: MainEnElHub) => Promise<T>): Promise<T> {
	return enElHub(nombre, async (hub: any) => prueba(await montarMainEnElHub(hub, TENANT)));
}

describe("SYNC-37 · dos nombres cruzados, en una reparación de la Main", () => {
	it("aparcando los nombres antes, la operación entra entera y no deja nada aparcado", async () => {
		await enUnHub("nombres-cruzados-aparcando", async (m) => {
			await m.mandarLote([
				opDelOutbox("op-1", [
					{ sql: ALTA, args: ["z-1", "Terraza"] },
					{ sql: ALTA, args: ["z-2", "Salón"] },
				]),
			]);

			const acuse = await m.mandarLote([
				opDelOutbox(
					"rep-1",
					[aparcar("z-1", "Salón"), aparcar("z-2", "Terraza"), escribir("z-1", "Salón"), escribir("z-2", "Terraza")],
					"main_reparacion",
				),
			]);

			expect(acuse.resultados).toEqual([expect.objectContaining({ opId: "rep-1", ok: true })]);
			expect(zonas(m.sql)).toEqual(["z-1=Salón", "z-2=Terraza"]);
			expect(m.sql.exec("SELECT COUNT(*) AS n FROM Zonas WHERE instr(Nombre_Zona, char(1)) > 0;").one().n).toBe(0);
		});
	});

	it("sin aparcar, la primera escritura choca con la otra zona y no entra nada", async () => {
		await enUnHub("nombres-cruzados-sin-aparcar", async (m) => {
			await m.mandarLote([
				opDelOutbox("op-1", [
					{ sql: ALTA, args: ["z-1", "Terraza"] },
					{ sql: ALTA, args: ["z-2", "Salón"] },
				]),
			]);

			const acuse = await m.mandarLote([
				opDelOutbox("rep-1", [escribir("z-1", "Salón"), escribir("z-2", "Terraza")], "main_reparacion"),
			]);

			expect(acuse.resultados[0]).toMatchObject({ opId: "rep-1", ok: false, permanente: true });
			expect(zonas(m.sql)).toEqual(["z-1=Terraza", "z-2=Salón"]);
		});
	});
});
