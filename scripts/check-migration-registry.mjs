// scripts/check-migration-registry.mjs
//
// Anti-drift del WORKER: el runner de Rust embebe la carpeta de migraciones con include_dir!
// (automático), pero el worker las lista a mano en `tenantMigrations.ts` (esbuild no soporta glob
// dinámico). Este script garantiza que ese registro manual NO se desincronice de la carpeta:
//
//   - Todos los .sql de packages/database/migrations/ están en MIGRATIONS del worker, en orden.
//   - No hay entradas en MIGRATIONS que apunten a ficheros inexistentes.
//
// Además valida que ninguna migración contenga control de transacción (BEGIN TRANSACTION/COMMIT/
// ROLLBACK), que rompería la transacción interactiva del worker.
//
// Uso: node scripts/check-migration-registry.mjs   (sale con código 1 si hay problemas)

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(root, "packages", "database", "migrations");
const registryFile = join(
	root,
	"apps",
	"cloud-worker-licensing",
	"src",
	"server",
	"tenantMigrations.ts",
);

const errors = [];

// 1) Ficheros .sql en la carpeta (orden lexicográfico = orden de aplicación).
const folder = readdirSync(migrationsDir)
	.filter((f) => f.endsWith(".sql"))
	.sort();

if (folder.length === 0) {
	console.error("✗ check-migration-registry: la carpeta de migraciones está vacía.");
	process.exit(1);
}

// 2) Nombres registrados en el worker (en orden de aparición).
const registrySrc = readFileSync(registryFile, "utf8");
const registry = [...registrySrc.matchAll(/name:\s*"([^"]+\.sql)"/g)].map((m) => m[1]);

// 3) Comparar conjunto + orden.
if (JSON.stringify(folder) !== JSON.stringify(registry)) {
	errors.push(
		"El registro de migraciones del worker no coincide con la carpeta.\n" +
			`  Carpeta : ${JSON.stringify(folder)}\n` +
			`  Worker  : ${JSON.stringify(registry)}\n` +
			`  Arregla MIGRATIONS en ${registryFile} (importa el .sql y añádelo EN ORDEN).`,
	);
}

// 4) Lint anti-transacción en cada .sql (permite el BEGIN…END de triggers).
// Detecta: BEGIN; / BEGIN TRANSACTION / BEGIN DEFERRED / BEGIN IMMEDIATE / BEGIN EXCLUSIVE / COMMIT / ROLLBACK
const txControl = /\b(COMMIT|ROLLBACK|BEGIN\s*;|BEGIN\s+(TRANSACTION|DEFERRED|IMMEDIATE|EXCLUSIVE))\b/i;
for (const f of folder) {
	const sql = readFileSync(join(migrationsDir, f), "utf8");
	// Quita comentarios de bloque y de línea antes de comprobar.
	const stripped = sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
	if (txControl.test(stripped)) {
		errors.push(
			`La migración '${f}' contiene control de transacción (BEGIN TRANSACTION/COMMIT/ROLLBACK). ` +
				"Usa solo sentencias puras; la transacción la gestiona el runner.",
		);
	}
}

if (errors.length > 0) {
	console.error("✗ check-migration-registry: problemas encontrados:\n");
	for (const e of errors) console.error("- " + e + "\n");
	process.exit(1);
}

console.log(`✓ check-migration-registry: ${folder.length} migración(es) OK y registradas en orden.`);
