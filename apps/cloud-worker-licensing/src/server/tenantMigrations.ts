// src/server/tenantMigrations.ts
//
// El registro de migraciones del esquema de cada negocio en la nube. Es el ESPEJO del runner del
// escritorio (crates/tpv-infra-sqlite/src/migrations.rs): consume los MISMOS ficheros `.sql` de
// packages/database/migrations/ y lleva el mismo control por tabla `_migrations` (name, hash,
// applied_at). Quien las aplica es el TenantHub de cada negocio, en su SQLite
// (`migrarBaseLocal`, en `durableObjects/tenantHub.sqlite.ts`).
//
// Ya NO existe `schema.sql`: el esquema completo se construye ejecutando en orden todas las
// migraciones. Una base nueva nace vacía y se construye desde 0001; una existente solo aplica las
// pendientes.
//
// REGISTRO DE MIGRACIONES: el bundler del worker (esbuild) no soporta glob dinámico de ficheros,
// así que cada migración se importa explícitamente y se añade a `MIGRATIONS` (en orden). Es la
// única edición manual al añadir una migración (en Rust `include_dir!` las recoge solas).
//
// ⚠️ El esquema va COMPILADO dentro del worker: uno desplegado aprovisiona y migra sus negocios con
// el `0001` del día en que se desplegó. Cambiar el esquema sin redesplegar deja la nube por detrás
// de la Main, y la primera escritura que toque una columna nueva se rechaza (SYNC-20: así se paró la
// cola con `Razon_Social`). Tras tocar una migración, redespliega antes de probar nada con nube.
//
// Las tablas que sólo usa la nube (`Applied_Operations`, `Sync_Changes`, `Sync_Main_Checkpoints`)
// van también en el esquema único: en la Main quedan vacías. Así nacen al aprovisionar el negocio
// (SYNC-28).

import m0001 from "../../../../packages/database/migrations/0001_inicial.sql";
import m0002 from "../../../../packages/database/migrations/0002_negocio.sql";
import m0003 from "../../../../packages/database/migrations/0003_ingredientes.sql";
import m0004 from "../../../../packages/database/migrations/0004_producto_sin_categoria.sql";
import m0005 from "../../../../packages/database/migrations/0005_subida_completa.sql";

export const MIGRATIONS: { name: string; sql: string }[] = [
	{ name: "0001_inicial.sql", sql: m0001 },
	{ name: "0002_negocio.sql", sql: m0002 },
	{ name: "0003_ingredientes.sql", sql: m0003 },
	{ name: "0004_producto_sin_categoria.sql", sql: m0004 },
	{ name: "0005_subida_completa.sql", sql: m0005 },
];

/** Normaliza finales de línea (CRLF → LF) para que el hash sea estable entre sistemas. */
export function normalize(s: string): string {
	return s.replace(/\r\n/g, "\n");
}

export async function sha256Hex(s: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// RI-70: el esquema compartido incluye Encargado y Roles_Permisos.
