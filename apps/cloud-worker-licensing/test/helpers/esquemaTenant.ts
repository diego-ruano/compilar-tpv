// test/helpers/esquemaTenant.ts
//
// Construye el esquema de la BD de tenant REAL sobre el SqlStorage del Durable Object, aplicando las
// MISMAS migraciones que producción (packages/database/migrations). Así los tests de contrato corren
// contra el esquema de verdad, no contra un doble que emule las tablas.
//
// A diferencia de `runTenantMigrations`, esto no lleva control de versiones ni transacciones: es un
// levantado de esquema de un solo uso sobre una BD vacía.

import m0001 from "../../../../packages/database/migrations/0001_inicial.sql";
import m0002 from "../../../../packages/database/migrations/0002_horarios_agrupados.sql";

/** Quita comentarios de bloque y de línea (el parser de sqld/SqlStorage no siempre los tolera). */
function sinComentarios(sql: string): string {
	return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
}

/** Aplica el esquema sobre `sql` (el `ctx.storage.sql` del DO), sentencia a sentencia. */
export function crearEsquemaTenant(sql: any): void {
	// SqlStorage admite varias sentencias y conserva los BEGIN/END de los triggers.
	for (const mig of [m0001, m0002]) sql.exec(sinComentarios(mig));
}

// RI-70: el esquema compartido incluye Encargado y Roles_Permisos.
