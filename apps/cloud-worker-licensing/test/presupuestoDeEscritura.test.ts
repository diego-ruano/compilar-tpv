// test/presupuestoDeEscritura.test.ts
//
// AUD-36 · Lo que un negocio puede escribir en su base de la nube.
//
// El TenantHub ejecutaba lo que la Main le mandaba por el socket (DDL, una CTE recursiva que
// escribe miles de filas con un mensaje de 262 bytes, `zeroblob`, dos sentencias en un texto, una
// escritura en sus propias tablas), sin tope por operación ni presupuesto por hora; y una Handy
// escribía sin presupuesto. Aquí, contra el motor real y la base del negocio en el SQLite del DO:
//
//   · lo que no tiene la forma de lo que captura `WriteGuard` se rechaza como permanente, sin
//     escribir nada (`sentencia_no_admitida`);
//   · una operación que escribe más de su tope se deshace entera (`operacion_demasiado_grande`);
//   · con el presupuesto de la hora gastado, lo que llega espera (`presupuesto_agotado`): la de la
//     Main sale `transitorio` y la de una Handy, 429; a la hora siguiente entra;
//   · el outbox de un servicio de verdad cabe holgado en todo eso.

import { describe, expect, it } from "vitest";

import servicio from "./fixtures/outboxDeUnServicio.json";
import { enElHub } from "./helpers/hub";
import { montarMainEnElHub, opDelOutbox } from "./helpers/mainEnElHub";
import {
	PRESUPUESTO_POR_HORA,
	TOPE_DE_UNA_OPERACION,
	apuntarGasto,
	gastadoEnLaHora,
} from "../src/durableObjects/tenantHub.presupuesto";

const TENANT = "tenant-aud36";

const relleno = (filas: number, bytes: number) =>
	`INSERT INTO Relleno (x) SELECT zeroblob(${bytes}) FROM (WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < ${filas}) SELECT n FROM c);`;

const cuantas = (sql: any, tabla: string) => Number((sql.exec(`SELECT COUNT(*) AS n FROM ${tabla};`).toArray()[0] as any).n);
const hayTabla = (sql: any, nombre: string) =>
	sql.exec("SELECT 1 FROM sqlite_master WHERE name = ?;", nombre).toArray().length > 0;

describe("AUD-36 · lo que la Main no manda nunca no entra", () => {
	it("DDL, CTE recursiva con zeroblob, dos sentencias y las tablas del DO: permanentes y sin escribir", async () => {
		await enElHub("aud36-forma", async (hub: any) => {
			const m = await montarMainEnElHub(hub, TENANT);
			const zonasAntes = cuantas(m.sql, "Zonas");
			const acuse = await m.mandarLote([
				// El informe: una tabla que no es del esquema y 5.000 filas de 1.000 bytes en un mensaje.
				{ opId: "op-ddl", commandName: "x", command: { type: "tenantDb.exec", payload: { sql: "CREATE TABLE Relleno (x BLOB);" } } } as any,
				opDelOutbox("op-ddl-tx", [{ sql: "CREATE TABLE Relleno (x BLOB);" }]),
				opDelOutbox("op-relleno", [{ sql: relleno(5000, 1000) }]),
				opDelOutbox("op-dos", [{ sql: "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z-a', 'A'); CREATE TABLE Relleno (x BLOB);" }]),
				opDelOutbox("op-main-vigente", [{ sql: "UPDATE _Main_Vigente SET Device_Id = 'otra';" }]),
				opDelOutbox("op-log", [{ sql: "DELETE FROM Sync_Changes;" }]),
				// Detrás, una buena: el lote sigue (los rechazos son permanentes).
				opDelOutbox("op-buena", [{ sql: "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z-b', 'B');" }]),
			]);
			expect(acuse.ok).toBe(true);
			const porId = Object.fromEntries(acuse.resultados.map((r: any) => [r.opId, r]));
			for (const id of ["op-ddl", "op-ddl-tx", "op-relleno", "op-dos", "op-main-vigente", "op-log"]) {
				expect(porId[id], id).toMatchObject({ ok: false, permanente: true, transitorio: false });
				expect(String(porId[id].error), id).toContain("sentencia_no_admitida");
			}
			expect(porId["op-buena"]).toMatchObject({ ok: true });

			expect(hayTabla(m.sql, "Relleno")).toBe(false);
			expect(cuantas(m.sql, "Zonas")).toBe(zonasAntes + 1);
			expect(m.sql.exec("SELECT Device_Id FROM _Main_Vigente;").toArray()[0]).not.toEqual({ Device_Id: "otra" });
			expect(m.log().map((c) => c.opId)).toEqual(["op-buena"]);
		});
	});
});

describe("AUD-36 · el tope de una operación", () => {
	it("una que escribe más filas de las que caben se deshace entera y se aparta", async () => {
		await enElHub("aud36-filas", async (hub: any) => {
			const m = await montarMainEnElHub(hub, TENANT);
			m.sql.exec("DELETE FROM Zonas;");
			for (let i = 0; i < 50; i++) m.sql.exec("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES (?1, ?1);", `z${String(i).padStart(2, "0")}`);
			// Con la forma de la Main y sin nada prohibido: 50³ = 125.000 zonas.
			const acuse = await m.mandarLote([
				opDelOutbox("op-cubo", [
					{
						sql: "INSERT INTO Zonas (ID_Zona, Nombre_Zona) SELECT a.ID_Zona || b.ID_Zona || c.ID_Zona, a.ID_Zona || b.ID_Zona || c.ID_Zona FROM Zonas a, Zonas b, Zonas c;",
					},
				]),
			]);
			expect(acuse.resultados[0]).toMatchObject({ ok: false, permanente: true });
			expect(String(acuse.resultados[0].error)).toContain("operacion_demasiado_grande");
			expect(cuantas(m.sql, "Zonas")).toBe(50);
			expect(m.log()).toEqual([]);
			// Lo que escribió el intento cuenta para el presupuesto aunque se deshiciera.
			expect(gastadoEnLaHora(hub.state.storage, Date.now()).filas).toBeGreaterThan(TOPE_DE_UNA_OPERACION.filas);
		});
	});

	it("una que hace crecer la base más de lo que cabe, también", async () => {
		await enElHub("aud36-bytes", async (hub: any) => {
			const m = await montarMainEnElHub(hub, TENANT);
			m.sql.exec("DELETE FROM Zonas;");
			for (let i = 0; i < 20; i++) m.sql.exec("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES (?1, ?1);", `z${String(i).padStart(2, "0")}`);
			const antes = m.sql.databaseSize;
			// 400 zonas de 100 KB (lo más largo que da `printf` en el SQLite del DO): unos 40 MB, y
			// otros tantos de su índice, en muy pocas filas.
			const acuse = await m.mandarLote([
				opDelOutbox("op-gorda", [
					{
						sql: "INSERT INTO Zonas (ID_Zona, Nombre_Zona) SELECT 'g' || a.ID_Zona || b.ID_Zona, a.ID_Zona || b.ID_Zona || printf('%.*c', 100000, 'x') FROM Zonas a, Zonas b;",
					},
				]),
			]);
			expect(acuse.resultados[0]).toMatchObject({ ok: false, permanente: true });
			expect(String(acuse.resultados[0].error)).toContain("operacion_demasiado_grande");
			expect(cuantas(m.sql, "Zonas")).toBe(20);
			expect(m.sql.databaseSize - antes).toBeLessThan(TOPE_DE_UNA_OPERACION.bytes);
		});
	});

	it("el outbox de un servicio de verdad cabe holgado", async () => {
		await enElHub("aud36-servicio", async (hub: any) => {
			const m = await montarMainEnElHub(hub, TENANT);
			const st = hub.state.storage;
			st.transactionSync(() => {
				for (const [tabla, v] of Object.entries(servicio.maestros) as [string, { cols: string[]; rows: unknown[][] }][]) {
					const texto = `INSERT OR IGNORE INTO ${tabla} (${v.cols.join(", ")}) VALUES (${v.cols.map(() => "?").join(", ")});`;
					for (const fila of v.rows) st.sql.exec(texto, ...fila);
				}
			});
			const ops = (servicio.outbox as { sql: string; args: unknown[] }[][]).map((s, i) => opDelOutbox(`op-${i}`, s));
			let aplicadas = 0;
			for (let i = 0; i < ops.length; i += 200) {
				const acuse = await m.mandarLote(ops.slice(i, i + 200));
				for (const r of acuse.resultados) {
					expect(r.error ?? "", r.opId).not.toMatch(/sentencia_no_admitida|operacion_demasiado_grande|presupuesto_agotado/);
					if (r.ok) aplicadas++;
				}
			}
			expect(aplicadas).toBeGreaterThan(250);
			const gastado = gastadoEnLaHora(st, Date.now());
			// 300 operaciones de un servicio: muy lejos del presupuesto de una hora.
			expect(gastado.filas).toBeLessThan(PRESUPUESTO_POR_HORA.filas / 50);
			expect(gastado.bytes).toBeLessThan(PRESUPUESTO_POR_HORA.bytes / 50);
		});
	});
});

describe("AUD-36 · el presupuesto de la hora", () => {
	it("gastado, la operación de la Main espera (transitorio) sin escribir; a la hora siguiente entra", async () => {
		await enElHub("aud36-hora-main", async (hub: any) => {
			const m = await montarMainEnElHub(hub, TENANT);
			const st = hub.state.storage;
			apuntarGasto(st, Date.now(), PRESUPUESTO_POR_HORA.filas, 0);
			const op = opDelOutbox("op-espera", [{ sql: "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z-espera', 'Espera');" }]);
			const detras = opDelOutbox("op-detras", [{ sql: "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z-detras', 'Detrás');" }]);

			const acuse = await m.mandarLote([op, detras]);
			expect(acuse.resultados[0]).toMatchObject({ opId: "op-espera", ok: false, error: "presupuesto_agotado", transitorio: true, permanente: false });
			expect(acuse.resultados[1]).toMatchObject({ opId: "op-detras", ok: false });
			expect(m.sql.exec("SELECT 1 FROM Zonas WHERE ID_Zona IN ('z-espera', 'z-detras');").toArray()).toEqual([]);
			expect(m.eventos.some((e) => e.name === "presupuesto_agotado")).toBe(true);

			// La hora siguiente: lo apuntado era de la anterior.
			st.sql.exec("UPDATE _Presupuesto_Escritura SET Hora_Ms = Hora_Ms - 3600000;");
			const otra = await m.mandarLote([op, detras]);
			expect(otra.resultados.map((r: any) => r.ok)).toEqual([true, true]);
		});
	});

	it("gastado, la escritura de una Handy contesta presupuesto_agotado (429) sin escribir", async () => {
		await enElHub("aud36-hora-handy", async (hub: any) => {
			await montarMainEnElHub(hub, TENANT, { recovering: false });
			hub.isMainConnected = () => true;
			hub.isMainReady = () => true;
			const st = hub.state.storage;
			const escribir = (id: string) =>
				hub.applyInternalCommandIdempotent({
					tenantId: TENANT,
					cmd: {
						type: "tenantDb.transaction",
						payload: { steps: [{ kind: "execute", sql: "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES (?1, ?1);", args: [id] }] },
					},
					opId: crypto.randomUUID(),
					commandName: "zona",
					deviceId: "handy-lote",
					requestPayloadJson: JSON.stringify({ id }),
				});

			await escribir("z-antes");
			expect(gastadoEnLaHora(st, Date.now()).filas).toBeGreaterThan(0);

			apuntarGasto(st, Date.now(), 0, PRESUPUESTO_POR_HORA.bytes);
			await expect(escribir("z-gastado")).rejects.toMatchObject({ code: "presupuesto_agotado", status: 429 });
			expect(st.sql.exec("SELECT 1 FROM Zonas WHERE ID_Zona = 'z-gastado';").toArray()).toEqual([]);
		});
	});
});

