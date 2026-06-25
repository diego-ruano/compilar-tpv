// src/server/tenantMigrations.ts
//
// Migraciones versionadas del esquema de la BD **por-tenant (Turso)**. Es el ESPEJO de las
// migraciones del escritorio (crates/tpv-infra-sqlite/src/migrations.rs): el esquema es compartido,
// así que cualquier cambio que toque una tabla existente debe aplicarse en AMBOS lados con el mismo
// número de versión.
//
// Igual que en el escritorio, `schema.sql` se aplica con `CREATE TABLE IF NOT EXISTS` (crea tablas
// nuevas pero no modifica las existentes). Para los cambios sobre tablas existentes usamos
// `PRAGMA user_version` + pasos numerados.
//
// REGLAS: solo aditivo, nunca editar un paso ya publicado, mantener el mismo nº de versión que en
// `migrations.rs`. Ver RELEASING.md.

import type { Client } from "@libsql/client";

/// Debe COINCIDIR con `SCHEMA_VERSION` de migrations.rs.
export const SCHEMA_VERSION = 0;

/// Pasos para BDs de tenant ya existentes (mismo contenido/versión que en el escritorio).
const MIGRATIONS: { version: number; sql: string }[] = [
	// { version: 1, sql: "ALTER TABLE Productos ADD COLUMN Codigo_Barras TEXT;" },
];

/// `true` si la BD del tenant es nueva (aún no tiene tablas de negocio). Llamar ANTES de aplicar
/// `schema.sql`. Así una BD nueva no intenta correr ALTERs que el esquema completo ya incluye.
export async function tenantIsFresh(client: Client): Promise<boolean> {
	const r = await client.execute(
		"SELECT name FROM sqlite_master WHERE type='table' AND name='Roles' LIMIT 1;",
	);
	return (r.rows?.length ?? 0) === 0;
}

async function readUserVersion(client: Client): Promise<number> {
	const r = await client.execute("PRAGMA user_version;");
	const row = r.rows?.[0] as any;
	const v = row?.user_version ?? row?.[0] ?? 0;
	return Number(v) || 0;
}

async function setUserVersion(client: Client, version: number): Promise<void> {
	// PRAGMA no admite bind params; `version` es una constante del código.
	await client.execute(`PRAGMA user_version = ${version};`);
}

/// Lleva el esquema del tenant al día. Llamar DESPUÉS de aplicar `schema.sql`.
/// - `fresh = true`: BD nueva → sella a SCHEMA_VERSION sin correr migraciones.
/// - `fresh = false`: aplica los pasos pendientes y sella.
export async function runTenantMigrations(client: Client, fresh: boolean): Promise<void> {
	if (fresh) {
		await setUserVersion(client, SCHEMA_VERSION);
		return;
	}

	let current = await readUserVersion(client);

	for (const { version, sql } of MIGRATIONS) {
		if (version > current) {
			console.log(`[tenant-migrations] aplicando v${version}…`);
			await client.executeMultiple(sql);
			await setUserVersion(client, version);
			current = version;
		}
	}

	if (current < SCHEMA_VERSION) {
		await setUserVersion(client, SCHEMA_VERSION);
	}
}
