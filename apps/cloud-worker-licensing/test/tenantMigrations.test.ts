// test/tenantMigrations.test.ts
//
// SYNC-28: las tablas que sólo usa la nube nacen con el tenant.
//
// Antes las creaba el Durable Object al abrir su conexión. Un tenant recién aprovisionado no las
// tenía hasta la primera escritura por el DO, y la primera lectura por REST —el catch-up de una
// Main recién activada— reventaba con `no such table: Sync_Changes`. Ahora van en `0001`, y aquí se
// corre el runner de producción (`migrarBaseLocal`) sobre el SQLite del propio DO.

import { describe, it, expect } from "vitest";

import { enElHub } from "./helpers/hub";
import { HubError } from "../src/lib/errorHttp";
import { migrarBaseLocal } from "../src/durableObjects/tenantHub.sqlite";

describe("migraciones del tenant", () => {
	it("clasifica estructuradamente una migración publicada que fue modificada", async () => {
		await enElHub("migracion-alterada", async (hub: any) => {
			const sql = hub.state.storage.sql;
			sql.exec(
				"CREATE TABLE _migrations (name TEXT PRIMARY KEY, hash TEXT NOT NULL, applied_at INTEGER NOT NULL);",
			);
			sql.exec(
				"INSERT INTO _migrations (name, hash, applied_at) VALUES ('0001_inicial.sql', 'hash-incorrecto', 1);",
			);

			let capturado: unknown;
			try {
				await migrarBaseLocal(hub.state.storage);
			} catch (error) {
				capturado = error;
			}
			expect(capturado).toBeInstanceOf(HubError);
			expect(capturado).toMatchObject({
				code: "migration_altered",
				status: 500,
				details: { message: expect.stringContaining("0001_inicial.sql") },
			});
		});
	});

	it("un tenant recién aprovisionado ya tiene lo que lee el catch-up", async () => {
		await enElHub("migraciones-tenant-nuevo", async (hub: any) => {
			const sql = hub.state.storage.sql;
			await migrarBaseLocal(hub.state.storage);

			for (const tabla of ["Applied_Operations", "Sync_Changes", "Sync_Main_Checkpoints", "_Cobros_Pendientes"]) {
				const n = sql
					.exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?", tabla)
					.toArray()[0].n;
				expect(n, tabla).toBe(1);
			}
			// Las consultas con las que `/v1/sync/changes` lee el log, sus extremos y lo purgado (AUD-19).
			expect(sql.exec("SELECT COUNT(*) AS n FROM Sync_Changes WHERE Seq > 0;").toArray()[0].n).toBe(0);
			expect(sql.exec("SELECT COALESCE(MAX(Seq), 0) AS seq FROM Sync_Changes;").toArray()[0].seq).toBe(0);
			expect(sql.exec("SELECT MIN(Seq) AS primero FROM Sync_Changes;").toArray()[0].primero).toBeNull();
			expect(sql.exec("SELECT Last_Seq AS purgado FROM Sync_Main_Checkpoints WHERE Device_Id = ?1;", "_purgado_hasta").toArray()).toEqual([]);
			expect(sql.exec("PRAGMA table_info(Asignacion_Turnos)").toArray().some((c: any) => c.name === "ID_Grupo")).toBe(true);
			// El ajuste de «No vino» nace a 0 (nunca).
			expect(sql.exec("SELECT Reserva_No_Vino_Min AS m FROM Business_Settings WHERE ID = 1;").toArray()[0].m).toBe(0);
			// Todo el mundo nace pidiendo PIN.
			expect(sql.exec("SELECT COUNT(*) AS n FROM Usuarios WHERE Sin_PIN <> 0;").toArray()[0].n).toBe(0);
			// AUD-06: el sello de la base (0002) existe también en la nube, vacío: es de cada equipo, y el
			// volcado de recuperación descarta lo que empieza por `_`.
			expect(sql.exec("SELECT COUNT(*) AS n FROM _Negocio").toArray()[0].n).toBe(0);
			expect(sql.exec("SELECT COUNT(*) AS n FROM _migrations").toArray()[0].n).toBe(3);
			// Volver a ejecutar el runner conserva el esquema y no duplica sus registros.
			await migrarBaseLocal(hub.state.storage);
			expect(sql.exec("SELECT COUNT(*) AS n FROM _migrations").toArray()[0].n).toBe(3);
		});
	});
    it("RI-48 impone los valores de dominio en el SQL de la nube", async () => {
        await enElHub("ri48-valores-dominio", async (hub: any) => {
            const sql = hub.state.storage.sql;
            await migrarBaseLocal(hub.state.storage);
            for (const [tabla, columna] of [["Pagos", "Metodo_Pago"], ["Detalle_Comanda", "Estado_Cocina"],
                ["Reservas", "Estado"], ["Tareas", "Estado"], ["Tarea_Asignaciones", "Estado"],
                ["Fichajes", "Estado"], ["Movimientos_Caja", "Metodo_Pago"]]) {
                expect(() => sql.exec(`INSERT INTO ${tabla} (${columna}) VALUES ('DESCONOCIDO');`)).toThrow(/RI48/);
            }
            sql.exec("INSERT INTO Comandas (ID_Comanda, Fecha_Hora_Apertura, Canal) VALUES ('com', '2030-01-01', 'BARRA');");
            sql.exec("INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo) VALUES ('p', 'com', '2030-01-01', 'Efectivo', 100, 'COBRO');");
            expect(() => sql.exec("UPDATE Pagos SET Metodo_Pago = 'Otro' WHERE ID_Pago = 'p';")).toThrow(/RI48/);
            sql.exec("INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo, ID_Pago_Origen, Motivo_Devolucion) VALUES ('dev', 'com', '2030-01-01', 'Otro', -50, 'DEVOLUCION', 'p', 'Devuelto');");
            expect(sql.exec("SELECT COUNT(*) AS n FROM Pagos;").toArray()[0].n).toBe(2);
        });
    });

});
