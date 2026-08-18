// test/helpers/clienteSql.ts
//
// Un `Client` de libsql mínimo servido por el SQLite del Durable Object.
//
// Sirve para probar contra SQL DE VERDAD el código que en producción habla con Turso: el
// esquema del control-plane, los WHERE que deciden una adjudicación, los UPDATE condicionales.
// Un doble en memoria que "emule" esas cláusulas probaría el doble, no el código.

/** Devuelve algo con la forma de `Client` (libsql) sobre `ctx.storage.sql` del Durable Object. */
export function clienteSobre(sql: any) {
	return {
		async execute(entrada: any) {
			const texto = typeof entrada === "string" ? entrada : entrada.sql;
			const args = typeof entrada === "string" ? [] : (entrada.args ?? []);

			const cursor = sql.exec(texto, ...args);
			return { rows: cursor.toArray(), rowsAffected: cursor.rowsWritten ?? 0 };
		},
	} as any;
}
