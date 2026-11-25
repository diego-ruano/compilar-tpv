// src/durableObjects/cargaDeCopias.ts
//
// Cargar una copia (`volcadoSql.ts`) en la base de un objeto. Lo comparten las dos bases que viven
// en el SQLite de un Durable Object: la de cada negocio (`tenantHub.restaurar.ts`) y la central
// (`baseCentral.restaurar.ts`). Lo que cambia entre las dos lo dice quien llama (`ComoCargar`): las
// migraciones que sabe poner su worker, qué tablas puede traer la copia y cómo se prepara la base.
//
// La copia se lee de R2 según llega (descomprimida y partida en líneas, sin tenerla entera en
// memoria), y una línea más larga que la de la fila más grande que admite un objeto, como la escribe
// hoy la copia, la hace inservible (`CARACTERES_POR_LINEA`). El esquema lo ponen las migraciones del
// worker, no la copia: de ella sólo cuentan las líneas de datos, las que empiezan por
// `INSERT INTO "`, y de ninguna se ejecuta su texto. Cada una se lee entera con la misma gramática,
// sea corta o larga (`LectorDeFilas`):
//
//     INSERT INTO "<tabla>" ("<columna>", …) VALUES (<literal>, …);
//
// y nada más: ni otra sentencia, ni un comentario, ni espacios de más, ni varias filas. La tabla es
// una de las que puede traer la copia; cada columna, una de esa tabla en el esquema que han puesto
// las migraciones, sin repetir; y va un literal por columna, de los que escribe la copia
// (`Lectura`). Con lo leído, este código escribe la sentencia que se ejecuta (`conLiterales`,
// `conArgumentos`). Una línea que no se lee así hace inservible la copia, y se dice en qué línea y en
// qué carácter, y por qué con un código (`MotivoDeFila`), sin nada de lo que lleva.
//
// Antes de tocar nada se mira que la copia sea de un esquema que el worker sabe poner (sus
// migraciones son un principio de las de aquí), y al acabar, que esté entera (su línea de fin, con
// las mismas filas) y que no haya dejado ninguna clave foránea rota.
//
// Las filas entran con las claves foráneas apagadas, como en las migraciones: la copia va tabla a
// tabla en el orden en que se crearon, no padres primero. Lo comprueba `foreign_key_check` al final.
// Mientras tanto nada más puede tocar la base, y si algo falla, la base se queda como la deje: de las
// dos cosas se ocupa quien llama.

import type { Valor } from "../lib/sql";
import { ponerFk } from "./sqliteDelObjeto";
import {
	identificador,
	LINEA_FIN,
	LINEA_MIGRACIONES,
	literalEnUnaLinea,
	PRINCIPIO_DE_INSERT,
	reemplazarTodos,
	TextoPorTrozos,
} from "./volcadoSql";

/**
 * Lo que se dice de una copia que no se puede devolver, y por qué. Va en el `detalle` de la respuesta
 * y, de la copia de un negocio, también a Axiom (`copia_no_restaurada`); de la central, al rastro de la
 * administración va sólo su código (`motivoDe`, en `domains/admin/central.ts`). Sin nada que traiga la
 * copia (ni sus nombres ni sus datos): sólo números de línea, posiciones, recuentos, códigos y lo que
 * es de este worker (sus migraciones, sus tablas).
 */
export class CopiaInservible extends Error {
	constructor(
		readonly codigo: "copia_no_encontrada" | "copia_de_otra_version" | "copia_cortada" | "copia_no_valida",
		detalle: string,
		opciones?: ErrorOptions,
	) {
		super(`${codigo}: ${detalle}`, opciones);
		this.name = "CopiaInservible";
	}
}

/**
 * Unas filas de la copia que SQLite no acepta (`rechazadas`): la copia no vale (`copia_no_valida`), y
 * se dice dónde están y no qué llevan (`porQue`). Puede ser también un fallo de este worker (de quien
 * escribió la copia, de una migración), y por eso quien carga lo manda además a Sentry, con el texto de
 * SQLite, que puede citar lo que lleva la fila, sólo como causa.
 */
export class FilasRechazadas extends CopiaInservible {
	constructor(
		readonly porQue: string,
		causa: unknown,
	) {
		super("copia_no_valida", porQue, { cause: causa });
		this.name = "FilasRechazadas";
	}
}

/**
 * Las líneas de la copia, con un gzip que no se deja leer convertido en `CopiaInservible`. Una línea
 * demasiado larga ya lo es (`lineasDe`), y sale tal cual.
 *
 * Desde aquí no se distingue un gzip roto de una lectura de R2 que se corta a mitad: los dos dicen
 * «no se puede descomprimir», que puede ser pasajero (se repite antes de dar la copia por mala), y
 * los dos son una copia que no vale, que no va a Sentry, sólo adonde va una `CopiaInservible`.
 */
export async function* leyendoElGzip(lineas: AsyncIterable<string>): AsyncGenerator<string> {
	try {
		yield* lineas;
	} catch (error) {
		if (error instanceof CopiaInservible) throw error;
		throw new CopiaInservible("copia_no_valida", `no se puede descomprimir: ${String((error as Error)?.message ?? error)}`);
	}
}

/**
 * Por qué no se carga una línea de datos: un código, que es lo único que se dice de ella.
 *
 * - `fila_mal_formada`: no tiene la forma de una fila, o le sobra o le falta algo entre sus partes
 *   (un espacio, una coma, la comilla que cierra un nombre, otra fila detrás de la primera).
 * - `tabla_ajena`: la tabla no es de las que puede traer la copia.
 * - `columna_desconocida`, `columna_repetida`: una columna que no es de esa tabla, o que ya ha salido.
 * - `valor_no_literal`: un valor que no es un literal de los de la copia: una función, una
 *   subconsulta, una expresión, un texto que no se cierra…
 * - `valores_no_casan`: no va un valor por columna.
 * - `sobra_texto`: algo detrás del `;`: otra sentencia, un comentario, un espacio.
 */
type MotivoDeFila =
	| "fila_mal_formada"
	| "tabla_ajena"
	| "columna_desconocida"
	| "columna_repetida"
	| "valor_no_literal"
	| "valores_no_casan"
	| "sobra_texto";

/** Una línea de datos que no se carga: su número en la copia, el carácter donde falla y por qué. */
function filaInservible(numero: number, caracter: number, motivo: MotivoDeFila): CopiaInservible {
	return new CopiaInservible("copia_no_valida", `la línea ${numero} no se puede cargar: ${motivo} (carácter ${caracter + 1})`);
}

/**
 * Que una línea que se lee (la de las migraciones, una de datos) no acabe en CR, el `\r` que queda de
 * una copia con fines de línea de Windows (CRLF) partida por los `\n`. Sin esto se diría otra cosa:
 * que la copia es de otra versión (el `\r` se pega al nombre de la última migración) o que a una fila
 * le sobra texto. Las líneas que no se leen, como las del esquema, no se miran: un CREATE con sus
 * saltos de Windows dentro, como lo deja un volcado de una base que los traía, no estorba.
 */
function sinCr(linea: string, numero: number): void {
	if (linea.endsWith("\r")) {
		throw new CopiaInservible(
			"copia_no_valida",
			`la línea ${numero} acaba en CR: la copia tiene fines de línea de Windows (CRLF); conviértela a LF`,
		);
	}
}

/**
 * Cuánto entra por transacción: las líneas que se juntan, en caracteres (unos 8 MB en memoria). Entre
 * lote y lote se espera a R2, y cada espera con algo escrito confirma lo escrito, que es lo que más
 * cuesta: con lotes de 500 filas, restaurar 150.000 tarda tres veces más.
 */
const CARACTERES_POR_LOTE = 4 * 1024 * 1024;

/**
 * Lo más largo que puede ser una línea de una copia, en caracteres. La fila más grande que admite el
 * SQLite de un objeto en producción es de 8 MB (8 MiB y 34 bytes, `MAX_ROW_LENGTH` de workerd), y su
 * línea, como la escribe hoy la copia, ocupa como mucho dos veces sus bytes, más los nombres de su
 * tabla y de sus columnas (`literalEnUnaLinea`): 16 MiB y unos KB. Juntar una más larga podría agotar
 * la memoria del objeto, que es de 128 MB.
 *
 * La copia de un negocio hecha por un worker anterior a `SALTOS_CON_CHAR` escribe con `char(10)` todos
 * los saltos de línea de un texto, 14 caracteres cada uno: si una fila suya lleva más de 1,27 millones
 * (o es de 8 MB y lleva más de unos 726.000), su línea pasa del tope, y esa copia no se restaura.
 */
export const CARACTERES_POR_LINEA = 17 * 1024 * 1024;

/**
 * Las líneas de un gzip, de una en una, según llegan. De la que no ha acabado se guardan sus trozos,
 * y se juntan una vez, cuando llega su salto: un texto que creciera trozo a trozo se copiaría entero
 * con cada uno (el gzip llega a trozos de 4 KB), y una línea de 16 MiB tardaría segundos en juntarse.
 * Una de más de `tope` caracteres hace inservible la copia en cuanto se pasa, sin esperar a su final
 * (`CARACTERES_POR_LINEA`; `tope` sólo lo cambian los tests).
 *
 * Si se deja de leer antes del final, por eso o porque quien lee se para (una línea que no vale, unas
 * filas que SQLite no acepta: `cargarCopia` cierra el iterador), se cancela la copia: la descompresión
 * del runtime pide lo que llega sin esperar a que se lea, y sin cancelarla seguiría con el resto.
 */
export async function* lineasDe(cuerpo: ReadableStream<Uint8Array>, tope = CARACTERES_POR_LINEA): AsyncGenerator<string> {
	const lector = cuerpo
		.pipeThrough(new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)
		.pipeThrough(new TextDecoderStream())
		.getReader();
	/** Los trozos de la línea que no ha acabado, y cuántos caracteres suman. */
	let trozos: string[] = [];
	let caracteres = 0;
	/** Cuántas líneas se han dado: la que se está leyendo es la siguiente. */
	let dadas = 0;
	const demasiadoLarga = () =>
		new CopiaInservible("copia_no_valida", `la línea ${dadas + 1} es demasiado larga: pasa de ${tope} caracteres`);
	let leida = false;
	try {
		for (;;) {
			const { value, done } = await lector.read();
			if (done) break;
			const partes = value.split("\n");
			const resto = partes.pop() ?? "";
			for (const parte of partes) {
				if (caracteres + parte.length > tope) throw demasiadoLarga();
				trozos.push(parte);
				const linea = trozos.length === 1 ? parte : trozos.join("");
				trozos = [];
				caracteres = 0;
				dadas++;
				yield linea;
			}
			if (caracteres + resto.length > tope) throw demasiadoLarga();
			if (resto) {
				trozos.push(resto);
				caracteres += resto.length;
			}
		}
		leida = true;
		if (trozos.length) yield trozos.join("");
	} finally {
		if (!leida) await lector.cancel().catch(() => undefined);
	}
}

/**
 * Cuántos caracteres van, como mucho, en cada llamada a `exec`. El SQLite de un objeto no admite un
 * texto de más de 100 KB por llamada (SQLITE_TOOBIG), y un carácter de un texto de JavaScript son, como
 * mucho, 3 bytes en UTF-8: por debajo de esto, cabe seguro. Las filas van de varias en varias porque
 * cada llamada tiene su coste fijo (también la traza de Sentry, que envuelve el SQL del objeto): una a
 * una, restaurar tarda el doble. Una fila de una línea más larga que esto (hasta los 8 MB que admite
 * un objeto en producción) va sola, con sus textos y sus bytes como argumentos (`conArgumentos`).
 */
const CARACTERES_POR_LLAMADA = Math.floor(100_000 / 3);

const COMILLA = 0x27; // '
const ABRE = 0x28; // (
const CIERRA = 0x29; // )
const COMA = 0x2c; // ,

/**
 * La forma de un número: el signo menos si lo lleva, sin ceros de más a la izquierda, sus decimales y
 * el exponente con su signo. Así lo escribe `String(n)` de JavaScript (`-3`, `12.5`, `1e+21`,
 * `5e-324`), y así se escribe también un REAL entero con su `.0` (`5.0`), sin JavaScript de por medio.
 *
 * La forma no basta: `1e+999` o un entero de 400 cifras también la tienen, y SQLite los guarda como
 * infinito, que ninguna copia escribe (`literalEnUnaLinea` no tiene literal para él) y con el que la
 * base ya no se podría copiar. Un número tiene que ser además finito (`Lectura.valor`).
 */
const NUMERO = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]\d+)?/y;

/**
 * Un número de la copia, ya leído con `NUMERO`. Va a la sentencia tal como venía: así SQLite le da el
 * tipo que le daría la línea (enlazado, un número entraría siempre como REAL).
 */
class Numero {
	constructor(readonly texto: string) {}
}

/** Un valor de una fila, ya leído: NULL, un número, un texto o unos bytes. */
type ValorLeido = null | Numero | string | Uint8Array<ArrayBuffer>;

/** Un texto en hexadecimal tiene que ser UTF-8, como lo escribe la copia; un BOM delante es del texto. */
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** El valor de un dígito hexadecimal, por su código, o -1. */
function digitoHex(c: number): number {
	if (c >= 0x30 && c <= 0x39) return c - 0x30;
	if (c >= 0x61 && c <= 0x66) return c - 0x57;
	if (c >= 0x41 && c <= 0x46) return c - 0x37;
	return -1;
}

/** El nombre en minúsculas, sólo en ASCII: SQLite no distingue así las mayúsculas en los nombres. */
const minusculas = (nombre: string) => nombre.replace(/[A-Z]+/g, (letras) => letras.toLowerCase());

/**
 * Una línea de datos mientras se lee: por dónde va (`i`), y su número en la copia, para decir dónde
 * falla. Los literales que lee son los que escribe `literalEnUnaLinea`, también los que escribía la
 * copia de un negocio antes de `SALTOS_CON_CHAR`, y nada más (`valor`).
 */
class Lectura {
	i = 0;

	constructor(
		readonly linea: string,
		readonly numero: number,
	) {}

	falla(motivo: MotivoDeFila, en: number = this.i): never {
		throw filaInservible(this.numero, en, motivo);
	}

	/** Si la línea sigue con `texto`, lo salta. */
	salta(texto: string): boolean {
		if (!this.linea.startsWith(texto, this.i)) return false;
		this.i += texto.length;
		return true;
	}

	/**
	 * Lo que va entre `comilla` (la simple de un texto, la doble de un nombre) desde `i`, con la comilla
	 * doblada dentro, y deja `i` detrás; `null` si en `i` no empieza o no se cierra. Primero se busca
	 * dónde se cierra, y luego se desdoblan las de dentro de una vez (`reemplazarTodos`): un texto de
	 * megas puede traer millones.
	 */
	entre(comilla: "'" | '"'): string | null {
		const { linea } = this;
		if (linea[this.i] !== comilla) return null;
		const desde = this.i + 1;
		let fin = linea.indexOf(comilla, desde);
		while (fin !== -1 && linea[fin + 1] === comilla) fin = linea.indexOf(comilla, fin + 2);
		if (fin === -1) return null;
		this.i = fin + 1;
		return reemplazarTodos(linea.slice(desde, fin), comilla + comilla, comilla);
	}

	/** Unos bytes en hexadecimal desde `i` hasta su comilla, y deja `i` detrás de ella; `null` si no lo son. */
	bytes(): Uint8Array<ArrayBuffer> | null {
		const { linea, i } = this;
		const fin = linea.indexOf("'", i);
		if (fin === -1 || (fin - i) % 2 !== 0) return null;
		const bytes = new Uint8Array((fin - i) / 2);
		for (let b = 0; b < bytes.length; b++) {
			const alto = digitoHex(linea.charCodeAt(i + 2 * b));
			const bajo = digitoHex(linea.charCodeAt(i + 2 * b + 1));
			if (alto < 0 || bajo < 0) return null;
			bytes[b] = alto * 16 + bajo;
		}
		this.i = fin + 1;
		return bytes;
	}

	/**
	 * Un literal desde `i`, y deja `i` detrás. Es uno de éstos:
	 *
	 * - `NULL`;
	 * - un número finito, como lo escribe `String(n)` (`NUMERO`);
	 * - un texto entre comillas simples, con la comilla doblada dentro: `'Ana O''Neil'`;
	 * - un texto con saltos de línea, entre paréntesis: sus trozos entre comillas, unidos por
	 *   `||char(10)||` o `||char(13)||`, uno por salto y alguno: `('a'||char(13)||''||char(10)||'b')`.
	 *   Cuántos, da igual, mientras quepan en la línea (`CARACTERES_POR_LINEA`): la copia de un negocio
	 *   anterior a `SALTOS_CON_CHAR` los escribe todos así;
	 * - unos bytes en hexadecimal, `X'00ff'`, o un texto en UTF-8 en hexadecimal, `CAST(X'…' AS TEXT)`
	 *   (uno con un NUL o con muchos saltos de línea).
	 */
	valor(): ValorLeido {
		const desde = this.i;
		const c = this.linea.charCodeAt(desde);
		if (c === COMILLA) {
			const texto = this.entre("'");
			if (texto !== null) return texto;
		} else if (c === ABRE) {
			// Los trozos y sus saltos se juntan sin cuerda: una copia de antes de `SALTOS_CON_CHAR` puede
			// traer cientos de miles.
			this.i++;
			const texto = new TextoPorTrozos();
			let trozo = this.entre("'");
			let saltos = 0;
			while (trozo !== null) {
				texto.poner(trozo);
				const salto = this.salta("||char(10)||") ? "\n" : this.salta("||char(13)||") ? "\r" : null;
				if (salto === null) break;
				texto.poner(salto);
				trozo = this.entre("'");
				saltos++;
			}
			if (trozo !== null && saltos > 0 && this.salta(")")) return texto.texto();
		} else if (this.salta("NULL")) {
			return null;
		} else if (this.salta("X'")) {
			const bytes = this.bytes();
			if (bytes) return bytes;
		} else if (this.salta("CAST(X'")) {
			const bytes = this.bytes();
			if (bytes && this.salta(" AS TEXT)")) {
				try {
					return UTF8.decode(bytes);
				} catch {
					// No es UTF-8: no lo ha escrito la copia.
				}
			}
		} else {
			NUMERO.lastIndex = desde;
			const numero = NUMERO.exec(this.linea);
			// Finito para JavaScript es finito para SQLite: lo que JavaScript redondea al REAL más grande,
			// SQLite también. Al revés no siempre: uno justo por encima, que ninguna copia escribe, SQLite
			// lo deja en el más grande y JavaScript lo lee infinito, y aquí no entra.
			if (numero && Number.isFinite(Number(numero[0]))) {
				this.i += numero[0].length;
				return new Numero(numero[0]);
			}
		}
		return this.falla("valor_no_literal", desde);
	}
}

/** La cabecera de una fila, `INSERT INTO "<tabla>" (<columnas>) VALUES (`, ya comprobada. */
type Cabecera = {
	/** Como viene en la línea. Las filas de una tabla van seguidas, y todas empiezan igual. */
	enLaLinea: string;
	/** La tabla, con su nombre en el esquema. */
	tabla: string;
	columnas: number;
	/** El principio de la sentencia, con la tabla y las columnas con su nombre en el esquema. */
	sentencia: string;
};

/**
 * Una fila de la copia, lista para ejecutar: la sentencia que ha escrito este código, sus argumentos
 * si los lleva, y su número de línea y su tabla, para decir dónde está si SQLite no la acepta.
 */
type FilaDeLaCopia = { numero: number; tabla: string; sentencia: string; argumentos: Valor[] | null };

/** Lee las líneas de datos de una copia contra el esquema de la base. */
class LectorDeFilas {
	private ultima: Cabecera | null = null;
	private readonly columnas = new Map<string, ReadonlyMap<string, string>>();

	/** `tablas`: las que puede traer la copia, por su nombre en minúsculas (`minusculas`). */
	constructor(
		private readonly sql: SqlStorage,
		private readonly tablas: ReadonlyMap<string, string>,
	) {}

	/** La fila de una línea de datos (`PRINCIPIO_DE_INSERT`). Lanza `CopiaInservible` si no se lee. */
	leer(linea: string, numero: number): FilaDeLaCopia {
		const l: Lectura = new Lectura(linea, numero);
		let cabecera = this.ultima;
		if (cabecera && linea.startsWith(cabecera.enLaLinea)) l.i = cabecera.enLaLinea.length;
		else cabecera = this.ultima = this.cabecera(l);

		const valores: ValorLeido[] = [];
		for (;;) {
			const desde = l.i;
			// Uno más de los que tiene la fila ya no se lee: una línea de millones de literales cortos, que
			// cabe en `CARACTERES_POR_LINEA`, los guardaría todos antes del `)`, cientos de MB.
			if (valores.length === cabecera.columnas) l.falla("valores_no_casan", desde);
			valores.push(l.valor());
			if (l.salta(", ")) continue;
			const c = linea.charCodeAt(l.i);
			if (c === CIERRA) break;
			// Detrás de un literal va otro o el cierre: lo demás era una expresión, o le falta un espacio.
			if (c === COMA) l.falla("fila_mal_formada");
			l.falla("valor_no_literal", desde);
		}
		const cierre = l.i++;
		if (!l.salta(";")) l.falla("fila_mal_formada");
		if (l.i !== linea.length) l.falla("sobra_texto");
		if (valores.length !== cabecera.columnas) l.falla("valores_no_casan", cierre);

		// Con sus valores como literales si cabe en una llamada, que es lo normal: no es más larga que su
		// línea, salvo con un NUL suelto en un texto, que va en hexadecimal.
		if (linea.length <= CARACTERES_POR_LLAMADA) {
			const sentencia = conLiterales(cabecera, valores);
			if (sentencia.length <= CARACTERES_POR_LLAMADA) return { numero, tabla: cabecera.tabla, sentencia, argumentos: null };
		}
		return { numero, tabla: cabecera.tabla, ...conArgumentos(cabecera, valores) };
	}

	/** La cabecera de la línea, que no es la de la fila anterior. */
	private cabecera(l: Lectura): Cabecera {
		l.i = PRINCIPIO_DE_INSERT.length - 1;
		const enLaTabla = l.i;
		const nombre = l.entre('"');
		if (nombre === null) l.falla("fila_mal_formada");
		const tabla = this.tablas.get(minusculas(nombre));
		if (tabla === undefined) l.falla("tabla_ajena", enLaTabla);
		const deLaTabla = this.columnasDe(tabla);
		if (!l.salta(" (")) l.falla("fila_mal_formada");
		const columnas: string[] = [];
		do {
			const enLaColumna = l.i;
			const nombreDeColumna = l.entre('"');
			if (nombreDeColumna === null) l.falla("fila_mal_formada");
			const columna = deLaTabla.get(minusculas(nombreDeColumna));
			if (columna === undefined) l.falla("columna_desconocida", enLaColumna);
			if (columnas.includes(columna)) l.falla("columna_repetida", enLaColumna);
			columnas.push(columna);
		} while (l.salta(", "));
		if (!l.salta(") VALUES (")) l.falla("fila_mal_formada");
		return {
			enLaLinea: l.linea.slice(0, l.i),
			tabla,
			columnas: columnas.length,
			sentencia: `INSERT INTO ${identificador(tabla)} (${columnas.map(identificador).join(", ")}) VALUES (`,
		};
	}

	/** Las columnas de `tabla` en el esquema, por su nombre en minúsculas. */
	private columnasDe(tabla: string): ReadonlyMap<string, string> {
		let columnas = this.columnas.get(tabla);
		if (!columnas) {
			const nombres = this.sql.exec("SELECT name FROM pragma_table_info(?1);", tabla).toArray();
			columnas = new Map(nombres.map((f): [string, string] => [minusculas(String(f.name)), String(f.name)]));
			this.columnas.set(tabla, columnas);
		}
		return columnas;
	}
}

/** Lo que hace que un texto no vaya tal cual entre comillas: una comilla, que se dobla, o un NUL. */
const COMILLA_O_NUL = /['\0]/;

/**
 * Un valor como literal de una sentencia. Un texto va entre comillas con sus saltos de línea tal cual
 * (esta sentencia no se lee por líneas, y así no hacen honda la expresión); uno con un NUL, que no
 * cabe en un literal, y los bytes, como los escribe la copia (`literalEnUnaLinea`).
 */
function literal(v: ValorLeido): string {
	if (v === null) return "NULL";
	if (v instanceof Numero) return v.texto;
	if (typeof v === "string") {
		if (!COMILLA_O_NUL.test(v)) return `'${v}'`;
		if (!v.includes("\0")) return `'${v.replaceAll("'", "''")}'`;
	}
	return literalEnUnaLinea(typeof v === "string" ? v : v.buffer);
}

/** La sentencia de una fila con sus valores como literales (`literal`). */
function conLiterales(cabecera: Cabecera, valores: readonly ValorLeido[]): string {
	return `${cabecera.sentencia}${valores.map(literal).join(", ")});`;
}

/**
 * La sentencia de una fila que no cabe en una llamada (`CARACTERES_POR_LLAMADA`), con sus textos y sus
 * bytes como argumentos, que no cuentan para ese tope. Los números y los NULL se quedan en el texto:
 * así SQLite les da el mismo tipo que en `conLiterales`.
 */
function conArgumentos(cabecera: Cabecera, valores: readonly ValorLeido[]): { sentencia: string; argumentos: Valor[] } {
	const argumentos: Valor[] = [];
	const literales = valores.map((v) => {
		if (v === null || v instanceof Numero) return literal(v);
		argumentos.push(typeof v === "string" ? v : v.buffer);
		return "?";
	});
	return { sentencia: `${cabecera.sentencia}${literales.join(", ")});`, argumentos };
}

/**
 * Lo que se dice de unas filas que SQLite no acepta: en qué líneas de la copia están y de qué
 * tablas, y el código de SQLite. Nada de su contenido, que el texto de SQLite puede llevar (cita el
 * trozo que no entiende): ése va como causa, sólo a Sentry (`FilasRechazadas`).
 */
function rechazadas(error: unknown, filas: readonly FilaDeLaCopia[]): FilasRechazadas {
	const codigo = /\bSQLITE_[A-Z_]+\b/.exec(String((error as Error)?.message ?? error))?.[0] ?? "sin código de SQLite";
	const donde =
		filas.length === 1 ? `la línea ${filas[0].numero}` : `una de las líneas ${filas[0].numero}–${filas.at(-1)!.numero}`;
	const tablas = [...new Set(filas.map((f) => f.tabla))].join(", ");
	return new FilasRechazadas(`SQLite no acepta ${donde} de la copia (${tablas}): ${codigo}`, error);
}

/**
 * Ejecuta unas filas, en orden: las que llevan sus valores como literales, de varias en varias
 * mientras quepan en una llamada (`CARACTERES_POR_LLAMADA`), y las que llevan argumentos, solas.
 */
function ejecutarFilas(sql: SqlStorage, filas: readonly FilaDeLaCopia[]): void {
	let juntas: FilaDeLaCopia[] = [];
	let caracteres = 0;
	const soltar = () => {
		const estas = juntas;
		juntas = [];
		caracteres = 0;
		if (!estas.length) return;
		try {
			sql.exec(estas.map((f) => f.sentencia).join("\n"));
		} catch (error) {
			throw rechazadas(error, estas);
		}
	};
	for (const fila of filas) {
		if (fila.argumentos) {
			soltar();
			try {
				sql.exec(fila.sentencia, ...fila.argumentos);
			} catch (error) {
				throw rechazadas(error, [fila]);
			}
			continue;
		}
		// Cada una cabe sola en una llamada (`leer`).
		if (caracteres + fila.sentencia.length + 1 > CARACTERES_POR_LLAMADA) soltar();
		juntas.push(fila);
		caracteres += fila.sentencia.length + 1;
	}
	soltar();
}

/** Lo que cambia de una base a otra al cargar una copia. */
export type ComoCargar = {
	/** Las migraciones que sabe poner este worker, en orden: las de la copia tienen que ser un principio. */
	migraciones: readonly string[];
	/** Las tablas que puede traer la copia. Una línea de otra la hace inservible. */
	esTablaDeLaCopia: (tabla: string) => boolean;
	/**
	 * Pone el esquema sobre el que se cargan las filas. Se llama cuando ya se sabe que la copia es de
	 * un esquema que este worker pone, con las migraciones con las que se hizo.
	 */
	prepararBase: (migracionesDeLaCopia: readonly string[]) => Promise<void>;
};

export type CopiaCargada = { filas: number; tablas: number };

/**
 * Carga una copia en la base del objeto. Las tablas que puede traer se vacían antes de cargar (las
 * migraciones pueden sembrar filas, y la copia trae las suyas). Lanza `CopiaInservible` si la copia no
 * vale; si SQLite no acepta una de sus filas, la de `FilasRechazadas`, que dice dónde está y no qué
 * lleva (`rechazadas`). La base se queda como la deje. Si se para antes de leer la última línea, cierra
 * `lineas` (`return`), y `lineasDe` deja de pedir la copia.
 */
export async function cargarCopia(
	storage: DurableObjectStorage,
	lineas: AsyncIterable<string>,
	como: ComoCargar,
): Promise<CopiaCargada> {
	const iterador = lineas[Symbol.asyncIterator]();
	try {
		return await cargarDe(storage, iterador, como);
	} finally {
		await iterador.return?.();
	}
}

async function cargarDe(storage: DurableObjectStorage, iterador: AsyncIterator<string>, como: ComoCargar): Promise<CopiaCargada> {
	const sql = storage.sql;
	/** El número de la última línea leída, desde 1: con él se dice dónde está una que no vale. */
	let numero = 0;
	const siguiente = async () => {
		const leida = await iterador.next();
		if (!leida.done) numero++;
		return leida;
	};

	// La cabecera: con qué migraciones se hizo. Va antes del esquema, entre comentarios.
	let migraciones: string[] | null = null;
	for (;;) {
		const { value, done } = await siguiente();
		if (done) throw new CopiaInservible("copia_cortada", "sin datos");
		if (value.startsWith(LINEA_MIGRACIONES)) {
			sinCr(value, numero);
			migraciones = value.slice(LINEA_MIGRACIONES.length).split(",").filter(Boolean);
			break;
		}
		if (!value.startsWith("--")) break;
	}
	if (!migraciones) throw new CopiaInservible("copia_no_valida", "sin la línea de las migraciones");
	const aqui = como.migraciones;
	const distinta = migraciones.findIndex((m, i) => m !== aqui[i]);
	if (distinta !== -1) {
		// Cuál y cuántas, con los nombres de aquí: los de la copia pueden ser cualquier cosa.
		throw new CopiaInservible(
			"copia_de_otra_version",
			distinta < aqui.length
				? `la migración ${distinta + 1} de la copia no es ${aqui[distinta]}, la de este worker`
				: `la copia trae ${migraciones.length} migraciones y este worker sabe poner ${aqui.length}, hasta ${aqui.at(-1) ?? "ninguna"}`,
		);
	}

	await como.prepararBase(migraciones);
	const tablas = new Map(
		(sql.exec("SELECT name FROM sqlite_master WHERE type = 'table';").toArray() as { name: string }[])
			.map((f) => String(f.name))
			.filter(como.esTablaDeLaCopia)
			.map((t): [string, string] => [minusculas(t), t]),
	);
	const lector = new LectorDeFilas(sql, tablas);

	await ponerFk(storage, false);
	try {
		storage.transactionSync(() => {
			for (const t of tablas.values()) sql.exec(`DELETE FROM ${identificador(t)};`);
		});

		let filas = 0;
		let fin: number | null = null;
		const llenas = new Set<string>();
		let lote: FilaDeLaCopia[] = [];
		let caracteresDelLote = 0;
		const vaciarLote = () => {
			if (!lote.length) return;
			const estas = lote;
			lote = [];
			caracteresDelLote = 0;
			storage.transactionSync(() => ejecutarFilas(sql, estas));
		};

		for (;;) {
			const { value: linea, done } = await siguiente();
			if (done) break;
			if (linea.startsWith(LINEA_FIN)) {
				const m = /^(\d+) filas/.exec(linea.slice(LINEA_FIN.length));
				fin = m ? Number(m[1]) : -1;
				continue;
			}
			if (!linea.startsWith(PRINCIPIO_DE_INSERT)) continue;
			sinCr(linea, numero);
			const fila = lector.leer(linea, numero);
			lote.push(fila);
			caracteresDelLote += linea.length;
			llenas.add(fila.tabla);
			filas++;
			if (caracteresDelLote >= CARACTERES_POR_LOTE) vaciarLote();
		}
		vaciarLote();

		if (fin === null) throw new CopiaInservible("copia_cortada", "le falta la línea del final");
		if (fin !== filas) throw new CopiaInservible("copia_cortada", `dice ${fin} filas y trae ${filas}`);
		const rota = sql.exec("PRAGMA foreign_key_check;").toArray()[0] as { table?: string } | undefined;
		if (rota) throw new CopiaInservible("copia_no_valida", `deja una clave foránea rota en ${rota.table ?? "?"}`);
		return { filas, tablas: llenas.size };
	} finally {
		await ponerFk(storage, true);
	}
}
