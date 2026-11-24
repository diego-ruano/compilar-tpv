// scripts/check-migration-registry.mjs
//
// Anti-drift de los registros de migraciones del WORKER. El bundler del worker (esbuild) no soporta
// glob dinámico, así que cada base lista sus migraciones a mano:
//
//   - la de cada negocio, en `tenantMigrations.ts`, con los MISMOS ficheros que embebe el runner de
//     Rust con include_dir! (packages/database/migrations/);
//   - la central, en `server/central/migraciones.ts`, con los de `server/central/migraciones/`.
//
// Este script garantiza que ningún registro se desincronice de su carpeta:
//
//   - Todos los .sql de la carpeta están en el registro, en orden.
//   - No hay entradas en el registro que apunten a ficheros inexistentes.
//
// Además valida que ninguna migración contenga control de transacción (BEGIN TRANSACTION/COMMIT/
// ROLLBACK): la transacción de cada una la abre el runner.
//
// Uso: node scripts/check-migration-registry.mjs   (sale con código 1 si hay problemas)

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const worker = join(root, "apps", "cloud-worker-licensing", "src");

const BASES = [
	{
		nombre: "la base de cada negocio",
		carpeta: join(root, "packages", "database", "migrations"),
		registro: join(worker, "server", "tenantMigrations.ts"),
		lista: "MIGRATIONS",
	},
	{
		nombre: "la base central",
		carpeta: join(worker, "server", "central", "migraciones"),
		registro: join(worker, "server", "central", "migraciones.ts"),
		lista: "MIGRACIONES_DE_LA_CENTRAL",
	},
];

// Detecta: BEGIN; / BEGIN TRANSACTION / BEGIN DEFERRED / BEGIN IMMEDIATE / BEGIN EXCLUSIVE / COMMIT /
// ROLLBACK. Permite el BEGIN…END de un trigger.
const txControl = /\b(COMMIT|ROLLBACK|BEGIN\s*;|BEGIN\s+(TRANSACTION|DEFERRED|IMMEDIATE|EXCLUSIVE))\b/i;

const errors = [];
let total = 0;

for (const base of BASES) {
	// 1) Ficheros .sql en la carpeta (orden lexicográfico = orden de aplicación).
	const folder = readdirSync(base.carpeta)
		.filter((f) => f.endsWith(".sql"))
		.sort();

	if (folder.length === 0) {
		errors.push(`La carpeta de migraciones de ${base.nombre} está vacía (${base.carpeta}).`);
		continue;
	}
	total += folder.length;

	// 2) Nombres registrados en el worker (en orden de aparición).
	const registrySrc = readFileSync(base.registro, "utf8");
	const registry = [...registrySrc.matchAll(/name:\s*"([^"]+\.sql)"/g)].map((m) => m[1]);

	// 3) Comparar conjunto + orden.
	if (JSON.stringify(folder) !== JSON.stringify(registry)) {
		errors.push(
			`El registro de migraciones de ${base.nombre} no coincide con su carpeta.\n` +
				`  Carpeta : ${JSON.stringify(folder)}\n` +
				`  Worker  : ${JSON.stringify(registry)}\n` +
				`  Arregla ${base.lista} en ${base.registro} (importa el .sql y añádelo EN ORDEN).`,
		);
	}

	// 4) Lint anti-transacción en cada .sql, sin sus comentarios.
	for (const f of folder) {
		const sql = readFileSync(join(base.carpeta, f), "utf8");
		const stripped = sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
		if (txControl.test(stripped)) {
			errors.push(
				`La migración '${f}' de ${base.nombre} contiene control de transacción ` +
					"(BEGIN TRANSACTION/COMMIT/ROLLBACK). Usa solo sentencias puras; la transacción la gestiona el runner.",
			);
		}
	}
}

if (errors.length > 0) {
	console.error("✗ check-migration-registry: problemas encontrados:\n");
	for (const e of errors) console.error("- " + e + "\n");
	process.exit(1);
}

console.log(`✓ check-migration-registry: ${total} migración(es) OK y registradas en orden.`);
