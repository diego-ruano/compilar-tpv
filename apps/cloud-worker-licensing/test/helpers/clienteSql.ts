// test/helpers/clienteSql.ts
//
// Una `Base` (`lib/sql.ts`) mínima servida por el SQLite de un Durable Object de pruebas.
//
// Sirve para probar contra SQL DE VERDAD el código que lee y escribe sentencia a sentencia: los
// WHERE que deciden una adjudicación, los UPDATE condicionales. Un doble en memoria que "emule" esas
// cláusulas probaría el doble, no el código. Lo que tiene que entrar entero en la base central (sus
// operaciones) no pasa por aquí: se prueba contra la central de verdad (`helpers/central.ts`).

import { GuardaIncumplida } from "../../src/durableObjects/tenantHub.sqlite";

/**
 * Da a una fila del SqlStorage el acceso POSICIONAL que también tiene una `Fila` (`lib/sql.ts`).
 *
 * Una `Fila` se lee de las dos formas, `r.Nombre` y `r[3]`, y el worker usa las dos: la
 * mayoria de los `rows()` de cada dominio miran las claves, pero el de `inventario.queries.ts`
 * indexa por posición contra `rs.columns`. El SqlStorage del DO solo devuelve objetos con nombre,
 * así que sin esto ese dominio recibía filas vacías — un fallo del doble que se lee igual que una
 * divergencia real entre las dos implementaciones, que es justo lo que un harness no puede
 * permitirse.
 *
 * Los índices van como propiedades **no enumerables** a propósito: `Object.keys` y `JSON.stringify`
 * tienen que seguir viendo solo las columnas, porque los dos harness comparan las filas por su
 * conjunto de claves.
 */
function filaConAccesoPosicional(fila: any, columnas: string[]): any {
	if (!fila || typeof fila !== "object" || Array.isArray(fila)) return fila;
	columnas.forEach((col, i) => {
		Object.defineProperty(fila, i, { value: fila[col], enumerable: false });
	});
	Object.defineProperty(fila, "length", { value: columnas.length, enumerable: false });
	return fila;
}

/**
 * Devuelve una `Base` (`lib/sql.ts`) sobre `ctx.storage.sql` del Durable Object.
 *
 * Implementa `execute` y `batch`. El `batch` importa: es lo que usa el apply agrupado (SYNC-18) y
 * tiene que comportarse como el de una `Base` en las dos cosas de las que ese código depende —
 * atomicidad (todo o nada) y un `lastInsertRowid` por sentencia, que es de donde sale el `Seq` de
 * cada operación.
 */
export function clienteSobre(sql: any, storage?: any) {
	const ejecutar = (entrada: any) => {
		const texto = typeof entrada === "string" ? entrada : entrada.sql;
		const args = typeof entrada === "string" ? [] : (entrada.args ?? []);

		const cursor = sql.exec(texto, ...args);
		const columnas: string[] = cursor.columnNames ?? [];
		const rows = cursor.toArray().map((f: any) => filaConAccesoPosicional(f, columnas));
		// El SqlStorage del DO no expone `lastInsertRowid`, así que se le pregunta a SQLite. Solo
		// tras un INSERT: en cualquier otra sentencia el valor sería el del INSERT anterior y
		// confundiría a quien lo lea.
		const esInsert = /^\s*INSERT\b/i.test(String(texto));
		const lastInsertRowid = esInsert
			? Number(sql.exec("SELECT last_insert_rowid() AS id;").toArray()[0]?.id ?? 0)
			: 0;

		return { rows, columns: columnas, rowsAffected: cursor.rowsWritten ?? 0, lastInsertRowid };
	};

	return {
		async execute(entrada: any) {
			return ejecutar(entrada);
		},

		async batch(sentencias: any[]) {
			// SYNC-30: la guarda de un paso `guard` decide como en `loteEnBruto`: un número distinto
			// de 0 en la primera columna de la primera fila, o el lote se deshace con su error.
			const correr = () =>
				sentencias.map((s) => {
					const r = ejecutar(s);
					if (s?.guarda) {
						const valor = r.rows[0]?.[0];
						if (typeof valor !== "number" || valor === 0) throw new GuardaIncumplida(s.guarda);
					}
					return r;
				});
			// Con el `storage` delante hay todo-o-nada de verdad (`transactionSync` deshace el lote
			// si una sentencia revienta), que es lo que promete una `Base` y de lo que depende el apply
			// agrupado. Sin él el doble no es atómico: pásalo siempre que el test mire un rollback.
			return storage ? storage.transactionSync(correr) : correr();
		},
	} as any;
}
