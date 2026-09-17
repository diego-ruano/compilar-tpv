// test/helpers/clienteSql.ts
//
// Un `Client` de libsql mínimo servido por el SQLite del Durable Object.
//
// Sirve para probar contra SQL DE VERDAD el código que en producción habla con Turso: el
// esquema del control-plane, los WHERE que deciden una adjudicación, los UPDATE condicionales.
// Un doble en memoria que "emule" esas cláusulas probaría el doble, no el código.

/**
 * Da a una fila del SqlStorage el acceso POSICIONAL que también tiene la de libsql.
 *
 * Una `Row` de libsql se lee de las dos formas, `r.Nombre` y `r[3]`, y el worker usa las dos: la
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
 * Devuelve algo con la forma de `Client` (libsql) sobre `ctx.storage.sql` del Durable Object.
 *
 * Implementa `execute`, `batch` y `transaction`. El `batch` importa: es lo que usa el apply agrupado (SYNC-18) y
 * tiene que comportarse como el de libsql en las dos cosas de las que ese código depende —
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

		async batch(sentencias: any[], _modo?: string) {
			const correr = () => sentencias.map((s) => ejecutar(s));
			// Con el `storage` delante hay todo-o-nada de verdad (`transactionSync` deshace el lote
			// si una sentencia revienta), que es lo que promete libsql y de lo que depende el apply
			// agrupado. Sin él el doble no es atómico: pásalo siempre que el test mire un rollback.
			return storage ? storage.transactionSync(correr) : correr();
		},

		/**
		 * Transacción interactiva (REV-01). El SqlStorage no deja abrir una con `BEGIN` ni con
		 * `SAVEPOINT`, y `transactionSync` no admite un cuerpo asíncrono, así que el rollback se
		 * hace a mano: se fotografían las tablas al abrir y, si hay que deshacer, se devuelven a esa
		 * foto las que hayan cambiado. Dentro se leen las propias escrituras, como en libsql.
		 *
		 * Lo que NO emula es la concurrencia: dos transacciones abiertas a la vez se pisarían.
		 */
		async transaction(_modo?: string) {
			const foto = fotografiar(sql);
			let cerrada = false;
			return {
				async execute(entrada: any) {
					return ejecutar(entrada);
				},
				async commit() {
					cerrada = true;
				},
				async rollback() {
					if (cerrada) return;
					cerrada = true;
					const deshacer = () => restaurar(sql, foto);
					if (storage) storage.transactionSync(deshacer);
					else deshacer();
				},
				close() {},
			};
		},
	} as any;
}

type Foto = Map<string, { columnas: string[]; filas: any[]; huella: string }>;

/** Las tablas de usuario (ni las de SQLite ni las internas del Durable Object). */
function tablas(sql: any): string[] {
	return sql
		.exec(
			`SELECT name FROM sqlite_master
			 WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\';`,
		)
		.toArray()
		.map((r: any) => String(r.name));
}

function leerTabla(sql: any, tabla: string) {
	const cursor = sql.exec(`SELECT * FROM "${tabla}";`);
	const filas = cursor.toArray();
	const columnas: string[] = cursor.columnNames ?? [];
	return { columnas, filas, huella: JSON.stringify(filas) };
}

function fotografiar(sql: any): Foto {
	const foto: Foto = new Map();
	for (const tabla of tablas(sql)) foto.set(tabla, leerTabla(sql, tabla));
	return foto;
}

function restaurar(sql: any, foto: Foto): void {
	for (const tabla of tablas(sql)) {
		const antes = foto.get(tabla);
		if (!antes) {
			sql.exec(`DROP TABLE "${tabla}";`);
			continue;
		}
		// Sólo se tocan las que cambiaron: reescribir las demás podría chocar con sus FK.
		if (leerTabla(sql, tabla).huella === antes.huella) continue;
		sql.exec(`DELETE FROM "${tabla}";`);
		for (const fila of antes.filas) {
			const cols = antes.columnas.map((c) => `"${c}"`).join(", ");
			const marcas = antes.columnas.map(() => "?").join(", ");
			sql.exec(
				`INSERT INTO "${tabla}" (${cols}) VALUES (${marcas});`,
				...antes.columnas.map((c) => fila[c]),
			);
		}
	}
}

/**
 * El mismo cliente, pero la PRIMERA sentencia de una transacción que case con `patron` revienta.
 *
 * Es cómo se prueba un corte a mitad de una operación de varias escrituras (REV-01): lo que se
 * comprueba después es que no quedó nada a medias y que el reintento —ya sin fallo— lo aplica una
 * sola vez.
 */
export function conFalloSimulado(db: any, patron: RegExp) {
	let pendiente = true;
	return {
		...db,
		async transaction(modo?: string) {
			const tx = await db.transaction(modo);
			return {
				...tx,
				async execute(entrada: any) {
					const texto = typeof entrada === "string" ? entrada : entrada.sql;
					if (pendiente && patron.test(String(texto))) {
						pendiente = false;
						throw new Error("fallo_simulado");
					}
					return tx.execute(entrada);
				},
			};
		},
	} as any;
}
