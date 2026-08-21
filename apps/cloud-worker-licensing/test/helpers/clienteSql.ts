// test/helpers/clienteSql.ts
//
// Un `Client` de libsql mínimo servido por el SQLite del Durable Object.
//
// Sirve para probar contra SQL DE VERDAD el código que en producción habla con Turso: el
// esquema del control-plane, los WHERE que deciden una adjudicación, los UPDATE condicionales.
// Un doble en memoria que "emule" esas cláusulas probaría el doble, no el código.

/**
 * Devuelve algo con la forma de `Client` (libsql) sobre `ctx.storage.sql` del Durable Object.
 *
 * Implementa `execute` y `batch`. El `batch` importa: es lo que usa el apply agrupado (SYNC-18) y
 * tiene que comportarse como el de libsql en las dos cosas de las que ese código depende —
 * atomicidad (todo o nada) y un `lastInsertRowid` por sentencia, que es de donde sale el `Seq` de
 * cada operación.
 */
export function clienteSobre(sql: any, storage?: any) {
	const ejecutar = (entrada: any) => {
		const texto = typeof entrada === "string" ? entrada : entrada.sql;
		const args = typeof entrada === "string" ? [] : (entrada.args ?? []);

		const cursor = sql.exec(texto, ...args);
		const rows = cursor.toArray();
		// El SqlStorage del DO no expone `lastInsertRowid`, así que se le pregunta a SQLite. Solo
		// tras un INSERT: en cualquier otra sentencia el valor sería el del INSERT anterior y
		// confundiría a quien lo lea.
		const esInsert = /^\s*INSERT\b/i.test(String(texto));
		const lastInsertRowid = esInsert
			? Number(sql.exec("SELECT last_insert_rowid() AS id;").toArray()[0]?.id ?? 0)
			: 0;

		return { rows, rowsAffected: cursor.rowsWritten ?? 0, lastInsertRowid };
	};

	return {
		async execute(entrada: any) {
			return ejecutar(entrada);
		},

		async batch(sentencias: any[], _modo?: string) {
			const correr = () => sentencias.map((s) => ejecutar(s));
			// Con el `storage` delante hay todo-o-nada de verdad (`transactionSync` deshace el lote
			// si una sentencia revienta), que es lo que promete libsql y de lo que depende el apply
			// agrupado. Sin él el doble no es atómico: pásalo siempre que el test mire un rollback.
			return storage ? storage.transactionSync(correr) : correr();
		},
	} as any;
}
