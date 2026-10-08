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
//
// ⚠️ El esquema va COMPILADO dentro del worker: uno desplegado aprovisiona y migra sus tenants con
// el `0001` del día en que se desplegó. Cambiar el esquema sin redesplegar deja la nube por detrás
// de la Main, y la primera escritura que toque una columna nueva se rechaza (SYNC-20: así se paró la
// cola con `Razon_Social`). Tras tocar una migración, redespliega antes de probar nada con nube.
//
// Las tablas que sólo usa la nube (`Applied_Operations`, `Sync_Changes`, `Sync_Main_Checkpoints`)
// van también en el esquema único: en la Main quedan vacías. Así nacen al aprovisionar el tenant y
// no dependen de que el Durable Object abra antes su conexión (SYNC-28).

import type { Client } from "@libsql/client";

import { HubError } from "../lib/errorHttp";
import m0001 from "../../../../packages/database/migrations/0001_inicial.sql";
import m0002 from "../../../../packages/database/migrations/0002_horarios_agrupados.sql";

const MIGRATIONS: { name: string; sql: string }[] = [
	{ name: "0001_inicial.sql", sql: m0001 },
	{ name: "0002_horarios_agrupados.sql", sql: m0002 },
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

/** Lee el set de migraciones aplicadas (`name -> hash`) desde `client` o desde una transacción. */
async function readApplied(
	run: (sql: string) => Promise<{ rows: any[] }>,
): Promise<Map<string, string>> {
	const res = await run("SELECT name, hash FROM _migrations;");
	const applied = new Map<string, string>();
	for (const row of res.rows as any[]) {
		applied.set(String(row.name), String(row.hash));
	}
	return applied;
}

/**
 * Aplica las migraciones pendientes sobre la BD del tenant. Construye el esquema desde cero en BDs
 * nuevas y pone al día las existentes.
 *
 * Garantía de transacción: **cada migración se aplica en su propia transacción** (migración + su
 * registro en `_migrations` entran juntos o ninguno), igual que el runner de escritorio en
 * `crates/tpv-infra-sqlite/src/migrations.rs`. Si una migración falla, las anteriores ya
 * confirmadas quedan registradas y no se vuelven a aplicar: solo se reintenta la que falló. Esto
 * evita que un fallo en la migración N deshaga DML no idempotente de las migraciones N-1 ya
 * aplicadas en la misma tanda.
 *
 * Como libsql serializa las transacciones de escritura, es seguro ante isolates concurrentes: cada
 * tx relee `_migrations` y se salta lo que otro isolate ya aplicó.
 *
 * Falla (rollback) si una migración ya aplicada fue modificada (hash distinto).
 */
export async function runTenantMigrations(client: Client): Promise<void> {
	await client.execute(
		"CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, hash TEXT NOT NULL, applied_at INTEGER NOT NULL);",
	);

	// Comprobación rápida (autocommit): verifica integridad de lo ya aplicado y detecta pendientes.
	// Si no hay nada pendiente, evitamos abrir una transacción de escritura (camino caliente barato).
	const applied = await readApplied((sql) => client.execute(sql));
	const pending: { name: string; body: string; hash: string }[] = [];
	for (const mig of MIGRATIONS) {
		const hash = await sha256Hex(normalize(mig.sql));
		const prev = applied.get(mig.name);
		if (prev !== undefined) {
			if (prev !== hash) {
				const message =
					`migration_altered: '${mig.name}' fue modificada tras aplicarse (hash distinto). ` +
					`Nunca edites una migración ya publicada: crea una nueva.`;
				throw new HubError("migration_altered", 500, { message });
			}
			continue;
		}
		pending.push({ name: mig.name, body: stripBlockComments(normalize(mig.sql)), hash });
	}

	if (pending.length === 0) return;

	// Hay pendientes: aplicar CADA UNA en su propia transacción, re-leyendo `_migrations` dentro de
	// la tx para serializar de forma segura entre isolates concurrentes.
	for (const mig of pending) {
		const tx = await client.transaction("write");
		try {
			// Otro isolate pudo aplicarla mientras esperábamos el lock de escritura.
			const appliedInTx = await readApplied((sql) => tx.execute(sql));
			if (appliedInTx.has(mig.name)) {
				await tx.rollback().catch(() => {});
				continue;
			}

			await tx.executeMultiple(mig.body);
			await tx.execute({
				sql: "INSERT INTO _migrations (name, hash, applied_at) VALUES (?, ?, ?);",
				args: [mig.name, mig.hash, Date.now()],
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

// RI-70: el esquema compartido incluye Encargado y Roles_Permisos.
