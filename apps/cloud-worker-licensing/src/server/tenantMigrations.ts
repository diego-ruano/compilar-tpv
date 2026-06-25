// src/server/tenantMigrations.ts
//
// Runner de migraciones del esquema para las BDs **por-tenant (Turso)**. Es el ESPEJO del runner
// del escritorio (crates/tpv-infra-sqlite/src/migrations.rs): consume los MISMOS ficheros `.sql` de
// packages/database/migrations/ y lleva el mismo control por tabla `_migrations` (name, hash,
// applied_at).
//
// Ya NO existe `schema.sql`: el esquema completo se construye ejecutando en orden todas las
// migraciones. Una BD de tenant nueva nace vacía y se construye desde 0001; una existente solo
// aplica las pendientes.
//
// REGISTRO DE MIGRACIONES: el bundler del worker (esbuild) no soporta glob dinámico de ficheros,
// así que cada migración se importa explícitamente y se añade a `MIGRATIONS` (en orden). Es la
// única edición manual al añadir una migración (en Rust `include_dir!` las recoge solas).

import type { Client } from "@libsql/client";

import m0001 from "../../../../packages/database/migrations/0001_inicial.sql";

const MIGRATIONS: { name: string; sql: string }[] = [
	{ name: "0001_inicial.sql", sql: m0001 },
	// Al añadir una migración: importa el .sql arriba y añade aquí su { name, sql } EN ORDEN.
];

/** Normaliza finales de línea (CRLF → LF) para que el hash sea estable entre sistemas. */
function normalize(s: string): string {
	return s.replace(/\r\n/g, "\n");
}

/** Quita comentarios de bloque: el parser de Turso (sqld) los rechaza. */
function stripBlockComments(s: string): string {
	return s.replace(/\/\*[\s\S]*?\*\//g, "");
}

async function sha256Hex(s: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Aplica las migraciones pendientes sobre la BD del tenant. Construye el esquema desde cero en BDs
 * nuevas y pone al día las existentes. Cada migración se aplica dentro de una transacción
 * interactiva junto con su registro en `_migrations`. Falla si una migración ya aplicada fue
 * modificada (hash distinto).
 */
export async function runTenantMigrations(client: Client): Promise<void> {
	await client.execute(
		"CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, hash TEXT NOT NULL, applied_at INTEGER NOT NULL);",
	);

	const res = await client.execute("SELECT name, hash FROM _migrations;");
	const applied = new Map<string, string>();
	for (const row of res.rows as any[]) {
		applied.set(String(row.name), String(row.hash));
	}

	for (const mig of MIGRATIONS) {
		const normalized = normalize(mig.sql);
		const hash = await sha256Hex(normalized);

		const prev = applied.get(mig.name);
		if (prev !== undefined) {
			if (prev !== hash) {
				throw new Error(
					`migration_altered: '${mig.name}' fue modificada tras aplicarse (hash distinto). ` +
						`Nunca edites una migración ya publicada: crea una nueva.`,
				);
			}
			continue;
		}

		const body = stripBlockComments(normalized);

		// Transacción interactiva: migración + registro, atómicos.
		const tx = await client.transaction("write");
		try {
			await tx.executeMultiple(body);
			await tx.execute({
				sql: "INSERT INTO _migrations (name, hash, applied_at) VALUES (?, ?, ?);",
				args: [mig.name, hash, Date.now()],
			});
			await tx.commit();
			console.log(`[tenant-migrations] aplicada: ${mig.name}`);
		} catch (e) {
			await tx.rollback().catch(() => {});
			throw e;
		} finally {
			tx.close();
		}
	}
}
