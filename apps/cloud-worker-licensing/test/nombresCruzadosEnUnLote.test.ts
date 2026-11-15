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

async function enUnHub<T>(nombre: string, prueba: (m: MainEnElHub, hub: any) => Promise<T>): Promise<T> {
	return enElHub(nombre, async (hub: any) => prueba(await montarMainEnElHub(hub, TENANT), hub));
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

// SYNC-38 · Una zona que sobra arriba con el nombre de otra que se sube.
//
// Aquí se renombró una zona y se creó otra con el nombre de antes: arriba sobra la vieja (`z-9`) y
// falta la nueva (`z-4`), con el mismo nombre. La reparación borra la que sobra detrás de todo lo que
// sube, así que antes aparca su nombre con la misma condición que su borrado
// (`contraste.rs::aparcar_si_la_nube_no_ha_cambiado`, cuyo texto fija su test
// `lo_que_sobra_aparca_sus_valores_unicos_con_la_condicion_de_su_borrado`): todo en una operación,
// que el TenantHub aplica en una transacción y en el turno del log. Si la nube ha cambiado desde la
// foto, ni se aparca ni se borra, y la operación no entra.

const CONDICION =
	"EXISTS (SELECT 1 FROM Sync_Changes WHERE Seq >= ?2) " +
	"AND NOT EXISTS (SELECT 1 FROM Sync_Changes WHERE Seq > ?2 AND Command_Name IS NOT ?3)";

const aparcarLaQueSobra = (id: string, hastaSeq: number) => ({
	sql: `UPDATE "Zonas" SET "Nombre_Zona" = ?4 WHERE "ID_Zona" = ?1 AND ${CONDICION};`,
	args: [id, hastaSeq, "main_reparacion", temporal(id)],
});
const borrarLaQueSobra = (id: string, hastaSeq: number) => ({
	sql: `DELETE FROM "Zonas" WHERE "ID_Zona" = ?1 AND ${CONDICION};`,
	args: [id, hastaSeq, "main_reparacion"],
});

const ultimoSeq = (sql: any): number => Number(sql.exec("SELECT MAX(Seq) AS s FROM Sync_Changes;").one().s);
const aparcadas = (sql: any): number =>
	Number(sql.exec("SELECT COUNT(*) AS n FROM Zonas WHERE instr(Nombre_Zona, char(1)) > 0;").one().n);

describe("SYNC-38 · una zona que sobra con el nombre de otra que se sube, en una reparación de la Main", () => {
	it("con la nube como en la foto, la que sobra aparca su nombre, la otra entra y la que sobra se borra", async () => {
		await enUnHub("sobra-con-el-nombre", async (m) => {
			await m.mandarLote([opDelOutbox("op-1", [{ sql: ALTA, args: ["z-9", "Patio"] }])]);
			const foto = ultimoSeq(m.sql);

			const acuse = await m.mandarLote([
				opDelOutbox(
					"rep-1",
					[aparcarLaQueSobra("z-9", foto), escribir("z-4", "Patio"), borrarLaQueSobra("z-9", foto)],
					"main_reparacion",
				),
			]);

			expect(acuse.resultados).toEqual([expect.objectContaining({ opId: "rep-1", ok: true })]);
			expect(zonas(m.sql)).toEqual(["z-4=Patio"]);
			expect(aparcadas(m.sql)).toBe(0);
		});
	});

	it("con una escritura de la Handy después de la foto, ni se aparca ni se borra, y no entra nada", async () => {
		await enUnHub("sobra-con-el-nombre-handy", async (m, hub) => {
			await m.mandarLote([opDelOutbox("op-1", [{ sql: ALTA, args: ["z-9", "Patio"] }])]);
			const foto = ultimoSeq(m.sql);

			// La Main ya ha soltado a las Handy, y una escribe entre la foto y la subida.
			m.main.servidor.serializeAttachment({ ...m.main.servidor.deserializeAttachment(), recovering: false });
			const deLaHandy = await hub.aplicar({
				tenantId: TENANT,
				deviceId: "handy-lote",
				opId: "op-handy",
				commandName: "crear_zona",
				command: { type: "tenantDb.exec", payload: { sql: ALTA, args: ["z-handy", "Barra"] } },
				clientNow: "",
			});
			expect(deLaHandy).toMatchObject({ ok: true });

			const acuse = await m.mandarLote([
				opDelOutbox(
					"rep-1",
					[aparcarLaQueSobra("z-9", foto), escribir("z-4", "Patio"), borrarLaQueSobra("z-9", foto)],
					"main_reparacion",
				),
			]);

			expect(acuse.resultados[0]).toMatchObject({ opId: "rep-1", ok: false, permanente: true });
			expect(zonas(m.sql)).toEqual(["z-9=Patio", "z-handy=Barra"]);
			expect(aparcadas(m.sql)).toBe(0);
		});
	});
});
