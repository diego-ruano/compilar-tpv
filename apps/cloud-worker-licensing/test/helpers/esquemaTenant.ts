// test/helpers/esquemaTenant.ts
//
// Construye el esquema de la BD de tenant REAL sobre el SqlStorage del Durable Object, aplicando las
// MISMAS migraciones que producción (packages/database/migrations). Así los tests de contrato corren
// contra el esquema de verdad, no contra un doble que emule las tablas.
//
// A diferencia de `runTenantMigrations`, esto no lleva control de versiones ni transacciones: es un
// levantado de esquema de un solo uso sobre una BD vacía. Como la BD arranca vacía, el rebuild de
// tabla de 0003 no tiene filas que arrastrar.

import m0001 from "../../../../packages/database/migrations/0001_inicial.sql";
import m0002 from "../../../../packages/database/migrations/0002_suelto_consumos.sql";
import m0003 from "../../../../packages/database/migrations/0003_stock_negativo.sql";
import m0004 from "../../../../packages/database/migrations/0004_iva_por_producto.sql";
import m0005 from "../../../../packages/database/migrations/0005_numero_ticket.sql";

/** Quita comentarios de bloque y de línea (el parser de sqld/SqlStorage no siempre los tolera). */
function sinComentarios(sql: string): string {
	return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
}

/** Aplica 0001..0005 sobre `sql` (el `ctx.storage.sql` del DO), sentencia a sentencia. */
export function crearEsquemaTenant(sql: any): void {
	for (const mig of [m0001, m0002, m0003, m0004, m0005]) {
		for (const stmt of sinComentarios(mig).split(";")) {
			const s = stmt.trim();
			if (s) sql.exec(s);
		}
	}
}
