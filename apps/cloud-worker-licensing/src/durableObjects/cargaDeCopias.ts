// src/durableObjects/cargaDeCopias.ts
//
// Cargar una copia (`volcadoSql.ts`) en la base de un objeto. Lo comparten las dos bases que viven
// en el SQLite de un Durable Object: la de cada negocio (`tenantHub.restaurar.ts`) y la central
// (`baseCentral.restaurar.ts`). Lo que cambia entre las dos lo dice quien llama (`ComoCargar`): las
// migraciones que sabe poner su worker, qué tablas puede traer la copia y cómo se prepara la base.
//
// La copia se lee de R2 según llega (descomprimida y partida en líneas, sin tenerla entera en
// memoria), y de ella sólo se ejecutan las líneas `INSERT` en tablas que la copia puede traer: el
// esquema lo ponen las migraciones del worker, no la copia. Antes de tocar nada se mira que la copia
// sea de un esquema que el worker sabe poner (sus migraciones son un principio de las de aquí), y al
// acabar, que esté entera (su línea de fin, con las mismas filas) y que no haya dejado ninguna clave
// foránea rota.
//
// Las filas entran con las claves foráneas apagadas, como en las migraciones: la copia va tabla a
// tabla en el orden en que se crearon, no padres primero. Lo comprueba `foreign_key_check` al final.
// Mientras tanto nada más puede tocar la base, y si algo falla, la base se queda como la deje: de las
// dos cosas se ocupa quien llama.

import type { Valor } from "../lib/sql";
import { ponerFk } from "./sqliteDelObjeto";
import { LINEA_FIN, LINEA_MIGRACIONES, PRINCIPIO_DE_INSERT, SALTOS_CON_CHAR } from "./volcadoSql";

/**
 * Lo que se dice de una copia que no se puede devolver, y por qué. Va en el `detalle` de la respuesta,
 * al log y a Axiom: sin nada que traiga la copia (ni sus nombres ni sus datos), sólo números de línea,
 * posiciones, recuentos, códigos y lo que es de este worker (sus migraciones, sus tablas).
 */
export class CopiaInservible extends Error {
	constructor(
		readonly codigo: "copia_no_encontrada" | "copia_de_otra_version" | "copia_cortada" | "copia_no_valida",
		detalle: string,
	) {
		super(`${codigo}: ${detalle}`);
		this.name = "CopiaInservible";
	}
}

/** Por qué no se carga una línea de datos: un código, que es lo único que se dice de ella. */
type MotivoDeFila = "tabla_ajena";

/** Una línea de datos que no se carga: su número en la copia, el carácter donde falla y por qué. */
function filaInservible(numero: number, caracter: number, motivo: MotivoDeFila): CopiaInservible {
	return new CopiaInservible("copia_no_valida", `la línea ${numero} no se puede cargar: ${motivo} (carácter ${caracter + 1})`);
}

/**
 * Cuánto entra por transacción: las líneas que se juntan, en caracteres (unos 8 MB en memoria). Entre
 * lote y lote se espera a R2, y cada espera con algo escrito confirma lo escrito, que es lo que más
 * cuesta: con lotes de 500 filas, restaurar 150.000 tarda tres veces más.
 */
const CARACTERES_POR_LOTE = 4 * 1024 * 1024;

/** Las líneas de un gzip, de una en una, según llegan. */
export async function* lineasDe(cuerpo: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const lector = cuerpo
		.pipeThrough(new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)
		.pipeThrough(new TextDecoderStream())
		.getReader();
	let resto = "";
	for (;;) {
		const { value, done } = await lector.read();
		if (done) break;
		const partes = (resto + value).split("\n");
		resto = partes.pop() ?? "";
		yield* partes;
	}
	if (resto) yield resto;
}

/** La tabla de una línea de datos, `INSERT INTO "<tabla>" (`, o `null` si no lo es. */
function tablaDe(linea: string): string | null {
	if (!linea.startsWith(PRINCIPIO_DE_INSERT)) return null;
	const m = /^INSERT INTO "((?:[^"]|"")+)" \(/.exec(linea);
	return m ? m[1].replaceAll('""', '"') : null;
}

/**
 * Cuántos caracteres de líneas de datos van, como mucho, en cada llamada a `exec`. El SQLite de un
 * objeto no admite un texto de más de 100 KB por llamada (SQLITE_TOOBIG), y un carácter de un texto de
 * JavaScript son, como mucho, 3 bytes en UTF-8: por debajo de esto, cabe seguro. Las líneas van de
 * varias en varias porque cada llamada tiene su coste fijo (también la traza de Sentry, que envuelve
 * el SQL del objeto): una a una, restaurar tarda el doble. Una sola línea más larga que esto (una fila
 * puede llegar a 2 MB) va sola, con sus textos como argumentos (`conArgumentos`).
 */
const CARACTERES_POR_LLAMADA = Math.floor(100_000 / 3);

/**
 * ¿Lleva la línea, entre todos sus textos, más saltos escritos con `char(…)` de los que
 * `literalEnUnaLinea` escribe así en un texto (`SALTOS_CON_CHAR`)? Entonces puede tener una expresión
 * más honda de lo que admite el SQLite de un objeto (100 niveles), y va sola, con sus textos como
 * argumentos, que no hacen honda ninguna. Así se carga también una copia que escribe así textos con
 * más saltos.
 */
function demasiadosSaltosConChar(linea: string): boolean {
	let n = 0;
	for (let i = linea.indexOf("||char("); i !== -1; i = linea.indexOf("||char(", i + 7)) {
		if (++n > SALTOS_CON_CHAR) return true;
	}
	return false;
}

const ENTRE_TROZOS = new Map([
	["||char(10)||", "\n"],
	["||char(13)||", "\r"],
]);

/**
 * La sentencia de una línea de datos que no cabe en una llamada (`CARACTERES_POR_LLAMADA`), o con
 * demasiados saltos escritos con `char(…)` (`demasiadosSaltosConChar`), con sus textos y sus blobs como
 * argumentos, que no cuentan para ese tope ni hacen honda la expresión. Los números y los NULL se
 * quedan en el texto: así SQLite les da el mismo tipo que les daría la línea tal cual (un número
 * enlazado entra siempre como REAL). Lee justo lo que escribe `literalEnUnaLinea`, y nada más: lo que
 * no reconoce hace inservible la copia.
 */
function conArgumentos(linea: string): [string, ...Valor[]] {
	const malFormada = () => new CopiaInservible("copia_no_valida", "una línea de datos que no se sabe leer");
	let i = PRINCIPIO_DE_INSERT.length - 1;

	/** Un texto entre comillas que empieza en `i` (`'…'`, con la comilla doble dentro); deja `i` detrás. */
	const entreComillas = (comilla: string): string => {
		if (linea[i] !== comilla) throw malFormada();
		let texto = "";
		for (i++; ; ) {
			const fin = linea.indexOf(comilla, i);
			if (fin === -1) throw malFormada();
			texto += linea.slice(i, fin);
			i = fin + 1;
			if (linea[i] !== comilla) return texto;
			texto += comilla;
			i++;
		}
	};
	const sigue = (texto: string) => {
		if (!linea.startsWith(texto, i)) throw malFormada();
		i += texto.length;
	};
	/** Los bytes de un hexadecimal que empieza en `i` y acaba en su comilla; deja `i` detrás. */
	const hex = (): Uint8Array<ArrayBuffer> => {
		const fin = linea.indexOf("'", i);
		if (fin === -1 || (fin - i) % 2 !== 0 || !/^[0-9a-f]*$/i.test(linea.slice(i, fin))) throw malFormada();
		const bytes = new Uint8Array((fin - i) / 2);
		for (let b = 0; b < bytes.length; b++) bytes[b] = parseInt(linea.slice(i + 2 * b, i + 2 * b + 2), 16);
		i = fin + 1;
		return bytes;
	};

	// La tabla y sus columnas, que se quedan como están.
	entreComillas('"');
	sigue(" (");
	for (;;) {
		entreComillas('"');
		if (linea.startsWith(", ", i)) i += 2;
		else break;
	}
	sigue(") VALUES (");

	let sentencia = linea.slice(0, i);
	const argumentos: Valor[] = [];
	for (;;) {
		if (linea[i] === "'") {
			argumentos.push(entreComillas("'"));
			sentencia += "?";
		} else if (linea[i] === "(") {
			// Un texto con saltos de línea: sus trozos, unidos por `char(10)` o `char(13)`.
			i++;
			let texto = entreComillas("'");
			for (;;) {
				const salto = ENTRE_TROZOS.get(linea.slice(i, i + 12));
				if (salto === undefined) break;
				i += 12;
				texto += salto + entreComillas("'");
			}
			sigue(")");
			argumentos.push(texto);
			sentencia += "?";
		} else if (linea.startsWith("X'", i)) {
			i += 2;
			argumentos.push(hex().buffer);
			sentencia += "?";
		} else if (linea.startsWith("CAST(X'", i)) {
			// Un texto con un NUL dentro, en hexadecimal.
			i += 7;
			argumentos.push(new TextDecoder().decode(hex()));
			sigue(" AS TEXT)");
			sentencia += "?";
		} else {
			const m = /^(?:NULL|-?\d+(?:\.\d+)?(?:e[+-]\d+)?)/.exec(linea.slice(i, i + 32));
			if (!m) throw malFormada();
			sentencia += m[0];
			i += m[0].length;
		}
		if (linea.startsWith(", ", i)) {
			sentencia += ", ";
			i += 2;
			continue;
		}
		if (linea.slice(i) !== ");") throw malFormada();
		return [`${sentencia});`, ...argumentos];
	}
}

/** Una línea de datos de la copia: su texto, su número de línea en la copia y su tabla. */
type LineaDeDatos = { texto: string; numero: number; tabla: string };

/**
 * Lo que se dice de unas líneas que SQLite no acepta: en qué líneas de la copia están y de qué
 * tablas, y el código de SQLite. Nada de su contenido, que el texto de SQLite sí lleva (cita el trozo
 * que no entiende): ése va como causa, sólo a Sentry.
 */
function rechazadas(error: unknown, lineas: readonly LineaDeDatos[]): Error {
	const codigo = /\bSQLITE_[A-Z_]+\b/.exec(String((error as Error)?.message ?? error))?.[0] ?? "sin código de SQLite";
	const donde =
		lineas.length === 1 ? `la línea ${lineas[0].numero}` : `una de las líneas ${lineas[0].numero}–${lineas.at(-1)!.numero}`;
	const tablas = [...new Set(lineas.map((l) => l.tabla))].join(", ");
	return new Error(`SQLite no acepta ${donde} de la copia (${tablas}): ${codigo}`, { cause: error });
}

/**
 * Ejecuta unas líneas de datos, en orden: de varias en varias, tal cual, mientras quepan en una
 * llamada, y la que no cabe sola o lleva demasiados saltos escritos con `char(…)`, sola y con sus
 * textos como argumentos.
 */
function ejecutarLineas(sql: SqlStorage, lineas: readonly LineaDeDatos[]): void {
	let juntas: LineaDeDatos[] = [];
	let caracteres = 0;
	const soltar = () => {
		const estas = juntas;
		juntas = [];
		caracteres = 0;
		if (!estas.length) return;
		try {
			sql.exec(estas.map((l) => l.texto).join("\n"));
		} catch (error) {
			throw rechazadas(error, estas);
		}
	};
	for (const linea of lineas) {
		if (linea.texto.length > CARACTERES_POR_LLAMADA || demasiadosSaltosConChar(linea.texto)) {
			soltar();
			const [sentencia, ...argumentos] = conArgumentos(linea.texto);
			try {
				sql.exec(sentencia, ...argumentos);
			} catch (error) {
				throw rechazadas(error, [linea]);
			}
			continue;
		}
		if (caracteres + linea.texto.length + 1 > CARACTERES_POR_LLAMADA) soltar();
		juntas.push(linea);
		caracteres += linea.texto.length + 1;
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
 * vale, y si SQLite no acepta una de sus líneas, un error que dice dónde está y no qué lleva
 * (`rechazadas`); la base se queda como la deje.
 */
export async function cargarCopia(
	storage: DurableObjectStorage,
	lineas: AsyncIterable<string>,
	como: ComoCargar,
): Promise<CopiaCargada> {
	const sql = storage.sql;
	const iterador = lineas[Symbol.asyncIterator]();
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
	const tablas = new Set(
		(sql.exec("SELECT name FROM sqlite_master WHERE type = 'table';").toArray() as { name: string }[])
			.map((f) => String(f.name))
			.filter(como.esTablaDeLaCopia),
	);

	await ponerFk(storage, false);
	try {
		storage.transactionSync(() => {
			for (const t of tablas) sql.exec(`DELETE FROM "${t.replaceAll('"', '""')}";`);
		});

		let filas = 0;
		let fin: number | null = null;
		const llenas = new Set<string>();
		let lote: LineaDeDatos[] = [];
		let caracteresDelLote = 0;
		const vaciarLote = () => {
			if (!lote.length) return;
			const sentencias = lote;
			lote = [];
			caracteresDelLote = 0;
			storage.transactionSync(() => ejecutarLineas(sql, sentencias));
		};

		for (;;) {
			const { value: linea, done } = await siguiente();
			if (done) break;
			if (linea.startsWith(LINEA_FIN)) {
				const m = /^(\d+) filas/.exec(linea.slice(LINEA_FIN.length));
				fin = m ? Number(m[1]) : -1;
				continue;
			}
			const tabla = tablaDe(linea);
			if (tabla === null) continue;
			if (!tablas.has(tabla)) throw filaInservible(numero, PRINCIPIO_DE_INSERT.length - 1, "tabla_ajena");
			lote.push({ texto: linea, numero, tabla });
			caracteresDelLote += linea.length;
			llenas.add(tabla);
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
