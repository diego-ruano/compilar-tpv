// src/lib/sql.ts
//
// Cómo habla el worker con una base SQLite: la de cada negocio, en el SQLite de su TenantHub
// (`durableObjects/tenantHub.sqlite.ts`), y la central (`server/db.ts`). Las doscientas consultas
// del worker leen `rows`, `columns` y `rowsAffected` sin saber dónde vive la base.
//
// Una sentencia lleva sólo argumentos posicionales (`?1`, `?2`…): ninguna consulta usa argumentos
// con nombre. Lo que se guarda, se lee y se pasa es un `Valor`, que es lo que admite el SQLite de un
// Durable Object. Lo que llega sin tipo (un `any`) lo convierte cada base a su manera: la del negocio
// sin exigir nada (`tenantHub.sqlite.ts`) y la central rechazando lo que no es un valor
// (`server/central/enlace.ts`).

/** Lo que guarda, devuelve y recibe una base: lo que admite el SQLite de un Durable Object. */
export type Valor = null | number | string | ArrayBuffer;

/** Una sentencia: texto suelto, o texto con sus argumentos posicionales. */
export type Sentencia = string | { sql: string; args?: Valor[] };

/**
 * Una fila, que se lee de las dos formas: por el nombre de su columna (`fila.tenant_id`) y por su
 * posición (`fila[0]`). Las posiciones no son enumerables: `Object.keys` y `JSON.stringify` sólo
 * ven las columnas.
 */
export interface Fila {
	length: number;
	[posicion: number]: Valor;
	[columna: string]: Valor;
}

/** Lo que devuelve una sentencia. */
export interface Resultado {
	columns: string[];
	rows: Fila[];
	/** Las filas que ha cambiado una escritura: las de la tabla, no las de sus índices (`changes()`). */
	rowsAffected: number;
	/** El `rowid` de la última fila insertada, tras un INSERT; `null` en cualquier otra sentencia. */
	lastInsertRowid: number | null;
}

/** Una base: sentencias sueltas, y lotes que entran enteros o no entran. */
export interface Base {
	execute(sentencia: Sentencia): Promise<Resultado>;
	/** Todo o nada: si una sentencia falla, no queda nada de las anteriores. */
	batch(sentencias: Sentencia[]): Promise<Resultado[]>;
}

/** Donde se puede ejecutar una sentencia. Las funciones que sólo ejecutan sentencias sueltas piden esto. */
export type Sql = Pick<Base, "execute">;

/**
 * Una base que se lee y se escribe sin esperas: la de una operación de la central, que corre entera
 * dentro de una transacción de su objeto (`server/central/operaciones/registro.ts`).
 */
export interface SqlSync {
	execute(sentencia: Sentencia): Resultado;
}
