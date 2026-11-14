// src/domains/sync/volcado.ts
//
// Cómo se lee y se escribe un volcado de la base del negocio: `/v1/sync/bootstrap` e `/historico`,
// las respuestas de sync que crecen con el negocio, y las páginas del contraste (`verificar.ts`).
//
// Cada fila se lee una vez y se escribe una vez, y lo escrito tiene un techo en bytes:
//
// - **Leer.** Un `Lector` ejecuta las sentencias y entrega, de cada una, sus columnas y sus filas
//   como listas posicionales que se recorren una sola vez. Dentro del TenantHub (`lib/enElHub.ts`)
//   es el cursor del SQLite del DO, fila a fila: no se monta un `ResultSet`, ni un objeto por fila
//   con una propiedad por celda (`aResultSet`), ni una segunda lista con las mismas filas.
// - **Escribir.** Un `Escritor` recibe el JSON por partes (una fila es el `JSON.stringify` de su
//   lista) y lo codifica a UTF-8 por trozos, contando los bytes. El texto de la respuesta entera
//   no llega a existir.
// - **El techo.** `VOLCADO_MAX_BYTES`. Quien escribe para en cuanto lo pasa, y cada ruta contesta
//   lo que ya contestaba cuando el volcado no cabía por filas.
//
// La ruta se ejecuta siempre dentro del TenantHub (`alHub`), y el lector sólo lee ahí: fuera lanza,
// como `tenantQuery`. Como el cursor se lee según se recorre, quien escribe puede parar a mitad sin
// haber cargado lo que no cabe.

import { parseClientNow, rewriteNowInSql } from "../../durableObjects/tenantHub.tiempo";
import { hubLocal } from "../../lib/hubLocal";
import { bytesUtf8 } from "../../lib/texto";
import type { ContextoDeLectura } from "../../lib/tenantClient";

/**
 * Techo de una respuesta de volcado, en bytes de JSON sin comprimir. Va además del tope de filas
 * de la fase 1: manda el que antes se alcance.
 *
 * Son 24 MiB por cuatro cosas que se miden en bytes y no en filas:
 *
 * - **La memoria del TenantHub**: 128 MB, con el negocio entero dentro. Lo escrito ocupa su tamaño
 *   una vez, y dos durante el instante en que se junta; con 24 MiB caben dos volcados a la vez (una
 *   recuperación y el contraste diario) con holgura.
 * - **La Main**, que descarga la respuesta entera dentro del plazo de un volcado, 150 s
 *   (`HTTP_TIMEOUT_VOLCADO_SECS`, `tpv-infra-licensing`), y la monta en memoria antes de
 *   restaurarla. 24 MiB en 150 s son 1,3 Mbit/s sin comprimir, y la Main la pide en gzip
 *   (`lib/gzip.ts`).
 * - **Lo que cabe.** Medido con un bar de mil comandas diarias (unas 22.500 filas y 4 MB al día),
 *   una fila ocupa unos 180 bytes: son unas 140.000 filas, seis días de ese bar o un mes de uno
 *   con la sexta parte de movimiento.
 */
export const VOLCADO_MAX_BYTES = 24 * 1024 * 1024;

/**
 * Techo de una página del histórico, en bytes de JSON sin comprimir. Más bajo que el de los volcados
 * (`VOLCADO_MAX_BYTES`): el histórico baja en muchas páginas, cada una ocupa el hilo del TenantHub
 * mientras se recorre y se escribe, y entre una y otra el negocio sigue atendiendo a la Main y a las
 * Handy. 4 MiB son unas 20.000 filas de las normales (unos 180 bytes cada una): por encima del tope
 * de filas (`HISTORICO_MAX_FILAS`, `sync.schemas.ts`), que es el que corta casi siempre, y por debajo de lo que tarda en
 * notarse.
 */
export const HISTORICO_MAX_BYTES = 4 * 1024 * 1024;

/** Una sentencia de lectura con sus argumentos posicionales. */
export type Sentencia = { sql: string; args: unknown[] };

/** Lo que devuelve una sentencia: sus columnas y sus filas, posicionales, que se recorren UNA vez. */
export type Resultado = { columnas: string[]; filas: Iterable<unknown[]> };

/**
 * Lee de la base del negocio sin copiar lo leído.
 *
 * `foto` ejecuta las sentencias como una sola foto de la base y le entrega sus resultados a `usar`,
 * en el mismo orden. Dentro del DO cada sentencia se ejecuta cuando `usar` pide su resultado, así
 * que una que no se llega a pedir no se ejecuta.
 *
 * ⚠️ `usar` es síncrona, y eso es lo que hace que la foto lo sea: el SQL del DO es síncrono y un
 * negocio es un hilo, así que mientras `usar` no espere a nada, ninguna escritura se intercala
 * entre la primera sentencia y la última. Con un `await` dentro dejaría de ser una foto.
 */
export type Lector = {
	foto<T>(sentencias: Sentencia[], usar: (resultados: Iterator<Resultado>) => T): Promise<T>;
};

/**
 * El lector del SQLite de un Durable Object: recorre el cursor, sin nada intermedio.
 *
 * Ninguna sentencia se queda a medias. Quien usa la foto puede dejar un resultado sin terminar (el
 * primer valor de un `COUNT`, un volcado que para al pasar del tope), y un cursor sin agotar deja su
 * sentencia abierta, con su lectura, hasta que el recolector de memoria lo retire. Así que lo que
 * quede de un resultado se recorre, sin guardarlo, antes de ejecutar la sentencia siguiente y al
 * terminar la foto.
 */
export function lectorDelHub(sql: SqlStorage): Lector {
	return {
		foto: async (sentencias, usar) => {
			let abierto: Iterator<unknown[]> | null = null;
			const agotar = () => {
				if (abierto) while (!abierto.next().done);
				abierto = null;
			};
			function* resultados(): Generator<Resultado> {
				for (const s of sentencias) {
					agotar();
					const cursor = sql.exec(s.sql, ...s.args);
					const filas = cursor.raw();
					abierto = filas;
					yield { columnas: cursor.columnNames, filas };
				}
			}
			try {
				return usar(resultados());
			} finally {
				agotar();
			}
		},
	};
}

/**
 * El lector de la petición en curso: el SQLite de al lado, dentro del TenantHub del negocio, que es
 * donde corre la ruta (`alHub`). Fuera de él lanza, como `tenantQuery`: es un router sin `alHub`. Un
 * test que monta el router suelto la ejecuta dentro con `dentroDelHub` y el SQLite de un DO de
 * verdad (`test/helpers/volcadoEnElHub.ts`). «Ahora» es el de quien pregunta (REV-03), fijado con la
 * misma función que `tenantQuery`.
 */
export function lectorDe(c: ContextoDeLectura): Lector {
	return {
		async foto(sentencias, usar) {
			const local = hubLocal(c.get("tenantId"));
			if (!local) {
				throw new Error("volcado: la ruta no se está ejecutando en el TenantHub de su negocio (¿falta alHub en su router?)");
			}
			const ahora = parseClientNow(c.req.header("X-Client-Now"));
			const fijadas = ahora
				? sentencias.map((s) => ({ sql: rewriteNowInSql(s.sql, ahora), args: s.args }))
				: sentencias;
			return lectorDelHub(await local.sql()).foto(fijadas, usar);
		},
	};
}

/** El resultado de la sentencia siguiente de una foto. */
export function siguiente(resultados: Iterator<Resultado>): Resultado {
	const r = resultados.next();
	if (r.done) throw new Error("volcado: la foto no trae más resultados");
	return r.value;
}

/** El primer valor de la primera fila: lo que devuelve un `COUNT(*)` o un `MAX`. */
export function primerValor(r: Resultado): unknown {
	for (const fila of r.filas) return fila[0] ?? null;
	return null;
}

/** Cuánto texto se junta antes de codificarlo. */
const TROZO_DE_TEXTO = 64 * 1024;

const CODIFICADOR = new TextEncoder();

/** Un texto corto, ya como cuerpo de respuesta. */
export function enBytes(texto: string): Uint8Array<ArrayBuffer> {
	return CODIFICADOR.encode(texto) as Uint8Array<ArrayBuffer>;
}

/**
 * Escribe un JSON por partes y cuenta lo que ocupa, en bytes de UTF-8 y al momento.
 *
 * El texto se junta en trozos de 64 KiB y cada trozo se codifica una vez: lo que queda en memoria
 * son los bytes de la respuesta, no su texto.
 *
 * Cada parte que se le da es un texto completo, como el que devuelve `JSON.stringify`: los bytes se
 * cuentan parte a parte, y un carácter partido entre dos (un par de sustitutos) se contaría de más.
 */
export class Escritor {
	private readonly trozos: Uint8Array[] = [];
	private pendiente: string[] = [];
	private caracteres = 0;
	private bytes = 0;

	constructor(private readonly tope: number) {}

	texto(t: string): void {
		this.pendiente.push(t);
		this.caracteres += t.length;
		this.bytes += bytesUtf8(t);
		if (this.caracteres >= TROZO_DE_TEXTO) this.codificar();
	}

	/** Lo escrito hasta ahora, en bytes. */
	get ocupado(): number {
		return this.bytes;
	}

	/** ¿Lo escrito pasa ya del tope? */
	get desbordado(): boolean {
		return this.bytes > this.tope;
	}

	private codificar(): void {
		if (!this.pendiente.length) return;
		this.trozos.push(CODIFICADOR.encode(this.pendiente.join("")));
		this.pendiente = [];
		this.caracteres = 0;
	}

	/** Lo escrito, entero y en un bloque. No mira el tope: es para quien ya paró a tiempo. */
	todo(): Uint8Array<ArrayBuffer> {
		this.codificar();
		const salida = new Uint8Array(this.trozos.reduce((n, trozo) => n + trozo.byteLength, 0));
		let i = 0;
		for (const trozo of this.trozos) {
			salida.set(trozo, i);
			i += trozo.byteLength;
		}
		return salida;
	}

	/** Lo escrito, o `null` si pasa del tope. */
	cerrar(): Uint8Array<ArrayBuffer> | null {
		return this.desbordado ? null : this.todo();
	}
}

/**
 * Escribe la lista de tablas de un volcado, cada una con sus columnas y sus filas posicionales (con
 * las tablas que hay, repetir el nombre de cada columna en cada fila multiplicaría el tamaño sin
 * añadir nada). Consume un resultado de la foto por tabla.
 *
 * `parcial` añade a cada tabla si lo que viaja de ella está recortado.
 *
 * Devuelve cuántas filas ha escrito, o `null` en cuanto pasa de `maxFilas` o lo escrito pasa del
 * tope del `Escritor`. Las filas se contaron antes de leer, pero fuera de esta foto: aquí se
 * cuentan las que hay de verdad.
 */
export function escribirTablas(
	e: Escritor,
	tablas: string[],
	resultados: Iterator<Resultado>,
	maxFilas: number,
	parcial?: (nombre: string) => boolean,
): number | null {
	let total = 0;
	e.texto("[");
	for (let i = 0; i < tablas.length; i++) {
		const nombre = tablas[i];
		const { columnas, filas } = siguiente(resultados);
		e.texto(
			`${i ? "," : ""}{"nombre":${JSON.stringify(nombre)},"columnas":${JSON.stringify(columnas)}` +
				(parcial ? `,"parcial":${parcial(nombre)}` : "") +
				`,"filas":[`,
		);
		let n = 0;
		for (const fila of filas) {
			e.texto(n ? `,${JSON.stringify(fila)}` : JSON.stringify(fila));
			n++;
			if (total + n > maxFilas || e.desbordado) return null;
		}
		e.texto("]}");
		total += n;
	}
	e.texto("]");
	return total;
}
