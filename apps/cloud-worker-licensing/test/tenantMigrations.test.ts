// test/tenantMigrations.test.ts
//
// SYNC-28: las tablas que sólo usa la nube nacen con el tenant.
//
// Antes las creaba el Durable Object al abrir su conexión. Un tenant recién aprovisionado no las
// tenía hasta la primera escritura por el DO, y la primera lectura por REST —el catch-up de una
// Main recién activada— reventaba con `no such table: Sync_Changes`. Ahora van en `0001`, y aquí se
// corre el runner de producción (`runTenantMigrations`) contra SQLite de verdad, el del propio DO.

import { describe, it, expect } from "vitest";

import { clienteSobre } from "./helpers/clienteSql";
import { enElHub } from "./helpers/hub";
import { HubError } from "../src/lib/errorHttp";
import { runTenantMigrations } from "../src/server/tenantMigrations";

/**
 * Lo que `runTenantMigrations` usa de un `Client` de libsql, sobre el SqlStorage del DO.
 *
 * La transacción no es real —el SqlStorage no la expone por esta vía— y aquí no hace falta: lo que
 * se prueba es qué esquema queda, no la concurrencia entre isolates.
 */
function clienteConMigraciones(sql: any) {
	const base = clienteSobre(sql);
	const ejecutarVarias = async (texto: string) => {
		// SQLite interpreta el bloque completo, incluidos los ; internos de los triggers.
		sql.exec(texto);
	};
	return {
		execute: base.execute,
		executeMultiple: ejecutarVarias,
		async transaction() {
			return {
				execute: base.execute,
				executeMultiple: ejecutarVarias,
				async commit() {},
				async rollback() {},
				close() {},
			};
		},
	} as any;
}

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
				await runTenantMigrations(clienteConMigraciones(sql));
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
			await runTenantMigrations(clienteConMigraciones(sql));

			for (const tabla of ["Applied_Operations", "Sync_Changes", "Sync_Main_Checkpoints", "_Cobros_Pendientes"]) {
				const n = sql
					.exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?", tabla)
					.toArray()[0].n;
				expect(n, tabla).toBe(1);
			}
			// Las dos consultas con las que `/v1/sync/changes` lee el log y su final.
			expect(sql.exec("SELECT COUNT(*) AS n FROM Sync_Changes WHERE Seq > 0;").toArray()[0].n).toBe(0);
			expect(sql.exec("SELECT COALESCE(MAX(Seq), 0) AS seq FROM Sync_Changes;").toArray()[0].seq).toBe(0);
			expect(sql.exec("PRAGMA table_info(Asignacion_Turnos)").toArray().some((c: any) => c.name === "ID_Grupo")).toBe(true);
			expect(sql.exec("SELECT COUNT(*) AS n FROM _migrations").toArray()[0].n).toBe(3);
			// Volver a ejecutar el runner conserva el esquema y no duplica sus registros.
			await runTenantMigrations(clienteConMigraciones(sql));
			expect(sql.exec("SELECT COUNT(*) AS n FROM _migrations").toArray()[0].n).toBe(3);
		});
	});
});
