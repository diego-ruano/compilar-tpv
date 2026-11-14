// test/reparacionEnUnLote.test.ts
//
// El borrado de una reparación del contraste, subido en un lote de la Main (`apply_lote`).
//
// El contraste con la nube borra arriba lo que sobra sólo si la nube no ha cambiado desde su foto
// (`contraste.rs::borrado_si_la_nube_no_ha_cambiado`): el `DELETE` lleva la condición de que el log
// tenga algo desde el `hasta_seq` de la foto y de que, por encima de él, no haya nada salvo las
// reparaciones de la misma pasada (`Command_Name = 'main_reparacion'`). Se apoya en que el TenantHub
// aplica cada operación de la Main en el turno del log, con su línea en `Sync_Changes`: la condición
// y el borrado son del mismo instante. Con el motor y la base de verdad, aquí se fija que eso sigue
// siendo así cuando las reparaciones suben en un lote:
//
//   · cada reparación del lote deja su línea en el log con su nombre, `main_reparacion`, y una no
//     impide a la siguiente del mismo lote borrar lo suyo;
//   · una escritura de la Handy entre la foto y el lote para el borrado, que se aplica sin borrar
//     nada (la pasada siguiente lo vuelve a mirar).
//
// El texto de la sentencia es el que fija `contraste.rs` en su test
// `un_borrado_solo_se_aplica_si_la_nube_no_ha_cambiado_desde_la_foto`.

import { describe, expect, it } from "vitest";

import { enElHub } from "./helpers/hub";
import { montarMainEnElHub, opDelOutbox, type MainEnElHub } from "./helpers/mainEnElHub";

const TENANT = "tenant-reparacion-lote";
const ALTA = "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES (?1, ?2);";

const zona = (n: number) => opDelOutbox(`op-${n}`, [{ sql: ALTA, args: [`z-${n}`, `Zona ${n}`] }]);

/** La reparación que borra una zona que sobra, tal como la encola el contraste de la Main. */
const borrarSiNoHaCambiado = (opId: string, idZona: string, hastaSeq: number) =>
	opDelOutbox(
		opId,
		[
			{
				sql:
					'DELETE FROM "Zonas" WHERE "ID_Zona" = ?1 AND EXISTS (SELECT 1 FROM Sync_Changes WHERE Seq >= ?2) ' +
					"AND NOT EXISTS (SELECT 1 FROM Sync_Changes WHERE Seq > ?2 AND Command_Name IS NOT ?3);",
				args: [idZona, hastaSeq, "main_reparacion"],
			},
		],
		"main_reparacion",
	);

const zonas = (sql: any): string[] =>
	sql.exec("SELECT ID_Zona FROM Zonas ORDER BY ID_Zona;").toArray().map((f: any) => String(f.ID_Zona));
const ultimoSeq = (sql: any): number => Number(sql.exec("SELECT MAX(Seq) AS s FROM Sync_Changes;").one().s);
const nombreEnElLog = (sql: any, opId: string): string =>
	String(sql.exec("SELECT Command_Name AS c FROM Sync_Changes WHERE Op_Id = ?1;", opId).one().c);

async function enUnHub<T>(nombre: string, prueba: (m: MainEnElHub, hub: any) => Promise<T>): Promise<T> {
	return enElHub(nombre, async (hub: any) => prueba(await montarMainEnElHub(hub, TENANT), hub));
}

describe("el borrado condicionado del contraste, en un lote de la Main", () => {
	it("con la nube como en la foto, las reparaciones del lote borran lo que sobra", async () => {
		await enUnHub("reparacion-lote-borra", async (m) => {
			await m.mandarLote([zona(1), zona(2), zona(3)]);
			const foto = ultimoSeq(m.sql);

			const acuse = await m.mandarLote([
				borrarSiNoHaCambiado("rep-2", "z-2", foto),
				borrarSiNoHaCambiado("rep-3", "z-3", foto),
			]);

			expect(acuse.resultados).toEqual([
				expect.objectContaining({ opId: "rep-2", ok: true }),
				expect.objectContaining({ opId: "rep-3", ok: true }),
			]);
			// La segunda ve en el log la línea de la primera, por encima de la foto, y es una reparación.
			expect(zonas(m.sql)).toEqual(["z-1"]);
			expect(nombreEnElLog(m.sql, "rep-2")).toBe("main_reparacion");
			expect(nombreEnElLog(m.sql, "rep-3")).toBe("main_reparacion");
		});
	});

	it("una escritura de la Handy después de la foto lo para: se aplica y no borra nada", async () => {
		await enUnHub("reparacion-lote-handy", async (m, hub) => {
			await m.mandarLote([zona(1), zona(2)]);
			const foto = ultimoSeq(m.sql);

			// La Main ya ha soltado a las Handy, y una escribe entre la foto y la subida.
			m.main.servidor.serializeAttachment({ ...m.main.servidor.deserializeAttachment(), recovering: false });
			const deLaHandy = await hub.aplicar({
				tenantId: TENANT,
				deviceId: "handy-lote",
				opId: "op-handy",
				commandName: "crear_zona",
				command: { type: "tenantDb.exec", payload: { sql: ALTA, args: ["z-handy", "De la Handy"] } },
				clientNow: "",
			});
			expect(deLaHandy).toMatchObject({ ok: true });

			const acuse = await m.mandarLote([borrarSiNoHaCambiado("rep-2", "z-2", foto)]);

			expect(acuse.resultados).toEqual([expect.objectContaining({ opId: "rep-2", ok: true })]);
			expect(zonas(m.sql)).toEqual(["z-1", "z-2", "z-handy"]);
			expect(nombreEnElLog(m.sql, "rep-2")).toBe("main_reparacion");
		});
	});
});
