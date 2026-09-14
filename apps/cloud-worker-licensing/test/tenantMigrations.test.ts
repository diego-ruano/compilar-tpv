// test/tenantMigrations.test.ts
//
// SYNC-28: las tablas que sólo existen en la nube son esquema del tenant y nacen con él.
//
// Antes las creaba el Durable Object al abrir su conexión. Un tenant recién aprovisionado no las
// tenía hasta la primera escritura por el DO, y la primera lectura por REST —el catch-up de una
// Main recién activada— reventaba con `no such table: Sync_Changes`. Aquí se corre el runner de
// producción (`runTenantMigrations`) contra SQLite de verdad, el del propio DO.

import { describe, it, expect } from "vitest";

import { clienteSobre } from "./helpers/clienteSql";
import { enElHub } from "./helpers/hub";
import { MIGRATIONS, runTenantMigrations } from "../src/server/tenantMigrations";
import { DDL_TABLAS_DE_NUBE } from "../src/server/tablasDeNube";

/**
 * Lo que `runTenantMigrations` usa de un `Client` de libsql, sobre el SqlStorage del DO.
 *
 * La transacción no es real —el SqlStorage no la expone por esta vía— y aquí no hace falta: lo que
 * se prueba es qué esquema queda, no la concurrencia entre isolates.
 */
function clienteConMigraciones(sql: any) {
	const base = clienteSobre(sql);
	const ejecutarVarias = async (texto: string) => {
		const sinComentarios = texto.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
		for (const s of sinComentarios.split(";")) {
			if (s.trim()) await base.execute(s);
		}
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

function existe(sql: any, tabla: string): boolean {
	return (
		sql.exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?", tabla).toArray()[0]
			.n === 1
	);
}

describe("migraciones del tenant", () => {
	it("un tenant recién aprovisionado ya tiene lo que lee el catch-up", async () => {
		await enElHub("migraciones-tenant-nuevo", async (hub: any) => {
			const sql = hub.state.storage.sql;
			await runTenantMigrations(clienteConMigraciones(sql));

			expect(existe(sql, "Sync_Changes")).toBe(true);
			expect(existe(sql, "Sync_Main_Checkpoints")).toBe(true);
			// La consulta con la que `/v1/sync/changes` calcula el final del log.
			expect(sql.exec("SELECT COALESCE(MAX(Seq), 0) AS seq FROM Sync_Changes;").toArray()[0].seq).toBe(0);

			const aplicadas = sql.exec("SELECT name FROM _migrations ORDER BY name;").toArray().map((f: any) => f.name);
			expect(aplicadas).toEqual(MIGRATIONS.map((m) => m.name).sort());
		});
	});

	it("un tenant que ya tenía las tablas, creadas por el DO de antes, migra sin tocarlas", async () => {
		await enElHub("migraciones-tenant-antiguo", async (hub: any) => {
			const sql = hub.state.storage.sql;
			for (const ddl of DDL_TABLAS_DE_NUBE) sql.exec(ddl);
			sql.exec(
				"INSERT INTO Sync_Changes (Op_Id, Statements_Json, Created_At_Ms) VALUES ('op-1', '[]', 1);",
			);

			await runTenantMigrations(clienteConMigraciones(sql));
			// Y otra vez: con todo aplicado no hace nada.
			await runTenantMigrations(clienteConMigraciones(sql));

			expect(sql.exec("SELECT COUNT(*) AS n FROM Sync_Changes;").toArray()[0].n).toBe(1);
		});
	});

	it("editar las tablas de nube de un tenant ya migrado se rechaza como cualquier migración", async () => {
		await enElHub("migraciones-tenant-alterado", async (hub: any) => {
			const sql = hub.state.storage.sql;
			await runTenantMigrations(clienteConMigraciones(sql));
			sql.exec("UPDATE _migrations SET hash = 'otro' WHERE name = 'nube_0001_replicacion';");

			await expect(runTenantMigrations(clienteConMigraciones(sql))).rejects.toThrow(/migration_altered/);
		});
	});
});
