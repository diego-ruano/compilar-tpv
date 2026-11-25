// src/durableObjects/volcadoSql.ts
//
// Lo que comparten las copias de las dos bases que viven en el SQLite de un objeto: la de cada
// negocio (`tenantHub.copia.ts`) y la central (`baseCentral.copia.ts`). Las dos son un volcado SQL
// comprimido con gzip, que abre `gunzip -c copia.sql.gz | sqlite3 copia.db` sin nada nuestro, y las
// dos se restauran con el mismo cargador (`cargaDeCopias.ts`). Su forma:
//
//   · En la cabecera, antes del esquema, la línea de las migraciones (`LINEA_MIGRACIONES`): con qué
//     esquema se hizo (`empezarVolcado`). La tabla `_migrations` no va dentro: al restaurar, el
//     esquema lo ponen las migraciones del worker, no la copia.
//   · El esquema (los CREATE de `sqlite_master`), para abrirla sin nuestro código, y los datos: una
//     sentencia `INSERT`, con sus columnas, por línea (`PRINCIPIO_DE_INSERT`, `volcarFilas`). Un
//     salto de línea dentro de un texto se escribe como `char(10)`, o el texto entero en hexadecimal
//     si lleva muchos (`literalEnUnaLinea`), y así la copia se puede restaurar leyéndola por líneas.
//   · Al final, la línea del fin (`LINEA_FIN`) con cuántas filas lleva: sin ella, está cortada
//     (`terminarVolcado`).
//   · Se comprime a trozos mientras se lee, sin esperas (`GzipPorTrozos`): leer y comprimir es una
//     foto, porque el objeto no atiende a nadie más entretanto, y en memoria sólo quedan el trozo
//     que se está llenando y lo ya comprimido.

import { constants, crc32, deflateRawSync } from "node:zlib";

/** La primera línea de los datos de cada tabla. Es lo único que se ejecuta al restaurar. */
export const PRINCIPIO_DE_INSERT = 'INSERT INTO "';
/** La línea que dice con qué migraciones se hizo la copia: sus nombres, separados por comas. */
export const LINEA_MIGRACIONES = "-- Migraciones: ";
/** La línea del final, con cuántas filas lleva la copia: sin ella, está cortada. */
export const LINEA_FIN = "-- Fin de la copia: ";

/** Cada cuántos caracteres sin comprimir se comprime un trozo. */
const TROZO_CARACTERES = 1024 * 1024;

/** El nombre de una tabla o una columna, entre comillas dobles. */
export function identificador(nombre: string): string {
	return `"${nombre.replaceAll('"', '""')}"`;
}

/**
 * Cuántos saltos de línea puede llevar un texto escrito con `char(10)`. Cada uno son dos `||` más en
 * la expresión, y el SQLite de un objeto no admite una de más de 100 niveles («Expression tree is too
 * large»): con 50 saltos ya no la ejecuta. Un texto con más, como el cuerpo de un evento de Stripe
 * con su sangría, va entero en hexadecimal.
 */
export const SALTOS_CON_CHAR = 40;

/**
 * Un valor de SQLite como literal SQL que cabe en una línea. Un salto de línea dentro de un texto se
 * escribe como `char(10)` (y el retorno de carro, `char(13)`); un texto con muchos, en hexadecimal,
 * como uno con un NUL.
 *
 * Un número sale como lo da el SQL del objeto, un número de JavaScript: un entero de más de 2^53 no
 * sale exacto, un REAL entero en una columna sin tipo vuelve como INTEGER, y uno de exponente extremo
 * (por debajo de 1e-20 o por encima de 1e200) puede cambiar en su último dígito al leerlo SQLite.
 * Ninguna columna de las dos bases guarda algo así: sus números son milisegundos, céntimos, recuentos
 * y cantidades.
 */
export function literalEnUnaLinea(v: SqlStorageValue): string {
	if (v === null) return "NULL";
	if (typeof v === "number") {
		// Un NaN o un infinito no tiene literal en SQL, y escribir NULL en su lugar sería una copia
		// que miente sin decirlo.
		if (!Number.isFinite(v)) throw new Error(`copia_valor_no_finito: ${v}`);
		return String(v);
	}
	if (typeof v === "string") {
		const saltos = v.match(/[\r\n]/g)?.length ?? 0;
		// Un NUL no puede ir dentro de un literal de texto: SQLite cortaría la cadena ahí. Se escribe
		// en hexadecimal y se vuelve a convertir en texto.
		if (v.includes("\0") || saltos > SALTOS_CON_CHAR) return `CAST(X'${hex(new TextEncoder().encode(v))}' AS TEXT)`;
		const escapado = `'${v.replaceAll("'", "''")}'`;
		if (saltos === 0) return escapado;
		return `(${escapado.replaceAll("\n", "'||char(10)||'").replaceAll("\r", "'||char(13)||'")})`;
	}
	if (v instanceof ArrayBuffer) return `X'${hex(new Uint8Array(v))}'`;
	// El SQLite de un objeto sólo devuelve esos cuatro tipos: otro sería una copia que no se sabe leer.
	throw new Error(`copia_valor_desconocido: ${typeof v}`);
}

const BYTE_EN_HEX = Array.from({ length: 256 }, (_, b) => b.toString(16).padStart(2, "0"));

function hex(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += BYTE_EN_HEX[b];
	return s;
}

/**
 * Un gzip de un solo miembro, comprimido a trozos y sin esperas.
 *
 * `CompressionStream` es asíncrono, y esperar mientras se lee dejaría de ser una foto. Cada trozo se
 * comprime por separado como deflate en bruto y se cierra con un vaciado completo (`Z_FULL_FLUSH`):
 * queda alineado a un byte y sin referencias a lo anterior, así que los trozos seguidos son un único
 * flujo deflate, que termina con un bloque final vacío. Delante va la cabecera de gzip y detrás su
 * CRC-32 y el tamaño, acumulados trozo a trozo. Es lo que hace `pigz`, y lo abre cualquier `gunzip`
 * y el `DecompressionStream` del runtime, que no acepta un gzip de varios miembros.
 *
 * `tope` es el techo de lo comprimido, en bytes: pasado, lanza `copia_demasiado_grande`. Al cerrar,
 * el fichero entero se monta junto a sus trozos, así que en memoria llega a ocupar dos veces eso.
 */
export class GzipPorTrozos {
	private pendiente: string[] = [];
	private caracteres = 0;
	private comprimido: Uint8Array[] = [];
	private bytesComprimidos = 0;
	private crc = 0;
	private bytesSinComprimir = 0;
	private readonly codificador = new TextEncoder();

	constructor(private readonly tope: number) {}

	linea(texto: string): void {
		this.pendiente.push(texto, "\n");
		this.caracteres += texto.length + 1;
		if (this.caracteres >= TROZO_CARACTERES) this.vaciar();
	}

	private vaciar(): void {
		if (!this.pendiente.length) return;
		const bytes = this.codificador.encode(this.pendiente.join(""));
		this.pendiente = [];
		this.caracteres = 0;
		this.crc = crc32(bytes, this.crc);
		this.bytesSinComprimir += bytes.length;
		this.anadir(deflateRawSync(bytes, { finishFlush: constants.Z_FULL_FLUSH }));
	}

	private anadir(trozo: Uint8Array): void {
		this.bytesComprimidos += trozo.length;
		if (this.bytesComprimidos > this.tope) {
			throw new Error(`copia_demasiado_grande: pasa de ${this.tope} bytes comprimida`);
		}
		this.comprimido.push(trozo);
	}

	cerrar(): { gzip: Uint8Array; bytesSinComprimir: number } {
		this.vaciar();
		// El bloque final, vacío: `deflateRawSync` de nada con `Z_FINISH`.
		this.anadir(deflateRawSync(new Uint8Array(0)));
		const cabecera = new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255]);
		const pie = new Uint8Array(8);
		const vista = new DataView(pie.buffer);
		vista.setUint32(0, this.crc >>> 0, true);
		vista.setUint32(4, this.bytesSinComprimir % 2 ** 32, true);

		const gzip = new Uint8Array(cabecera.length + this.bytesComprimidos + pie.length);
		let i = 0;
		for (const parte of [cabecera, ...this.comprimido, pie]) {
			gzip.set(parte, i);
			i += parte.length;
		}
		this.comprimido = [];
		return { gzip, bytesSinComprimir: this.bytesSinComprimir };
	}
}

/**
 * El principio de una copia: su título, cuándo se hizo, la línea de las migraciones, las notas de
 * cada base (cómo abrirla, cómo devolverla) y el principio de la transacción.
 */
export function empezarVolcado(
	gz: GzipPorTrozos,
	cabecera: { titulo: string; ahora: Date; migraciones: readonly string[]; notas: readonly string[] },
): void {
	gz.linea(`-- ${cabecera.titulo}`);
	gz.linea(`-- Generada: ${cabecera.ahora.toISOString()}`);
	gz.linea(`${LINEA_MIGRACIONES}${cabecera.migraciones.join(",")}`);
	for (const nota of cabecera.notas) gz.linea(`-- ${nota}`);
	gz.linea("PRAGMA foreign_keys=OFF;");
	gz.linea("BEGIN TRANSACTION;");
}

/**
 * Las filas de `tabla`, una sentencia `INSERT` con sus columnas por línea (`PRINCIPIO_DE_INSERT`), y
 * cuántas son. Con `porRowid`, en el orden en que entraron, que es el que tendrán al restaurarlas (una
 * tabla `WITHOUT ROWID` no lo tiene). El cursor se recorre entero (worker.md).
 */
export function volcarFilas(sql: SqlStorage, tabla: string, gz: GzipPorTrozos, opciones: { porRowid: boolean }): number {
	const nombre = identificador(tabla);
	const cursor = sql.exec(`SELECT * FROM ${nombre}${opciones.porRowid ? " ORDER BY rowid" : ""};`);
	const principio = `INSERT INTO ${nombre} (${cursor.columnNames.map(identificador).join(", ")}) VALUES (`;
	let n = 0;
	for (const fila of cursor.raw()) {
		gz.linea(`${principio}${fila.map(literalEnUnaLinea).join(", ")});`);
		n++;
	}
	return n;
}

/** El final de una copia: la línea del fin, con sus filas y sus tablas, y el de la transacción. */
export function terminarVolcado(gz: GzipPorTrozos, cuantas: { filas: number; tablas: number }): void {
	gz.linea(`${LINEA_FIN}${cuantas.filas} filas en ${cuantas.tablas} tablas`);
	gz.linea("COMMIT;");
}
