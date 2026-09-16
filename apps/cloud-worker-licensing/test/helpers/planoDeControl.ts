// test/helpers/planoDeControl.ts
//
// Las tablas de la base central (control-plane) en el SQLite de un Durable Object de pruebas.
//
// El worker no crea ni modifica la estructura de esa base: se gestiona a mano en Turso y está
// fotografiada en `docs/sql/control-plane/esquema-actual.sql`. Los tests, que corren contra un
// SQLite vacío y temporal, ejecutan esa misma foto. Así prueban contra la estructura de producción
// —claves primarias, CHECK, índices— y no contra una copia escrita a mano que pueda divergir.
//
// Es sólo de tests: no forma parte del worker ni se despliega.

import esquema from "../../../../docs/sql/control-plane/esquema-actual.sql?raw";

/**
 * Crea las tablas si esta base todavía no las tiene. Se puede llamar en cada caso de una suite
 * que reutiliza el mismo Durable Object: la segunda vez no hace nada.
 */
export function prepararPlanoDeControl(sql: any): void {
	const yaEsta = sql
		.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'licenses' LIMIT 1;`)
		.toArray().length;
	if (yaEsta) return;

	sql.exec(esquema);
}
