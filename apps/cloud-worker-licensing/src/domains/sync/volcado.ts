// src/domains/sync/volcado.ts
//
// Cómo se lee y se escribe un volcado de la base del negocio: `/v1/sync/bootstrap`, `/verificar` e
// `/historico`, las tres respuestas de sync que crecen con el negocio.
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
// Con la ruta ejecutándose en el Worker (`EJECUTAR_EN_EL_HUB` apagado, o un router suelto en un
// test), las filas llegan por `tenantQuery` y se escriben igual: lo que sale es lo mismo, byte a
// byte, y el techo es el mismo. Lo que cambia es cuándo actúa: allí las filas ya han cruzado la
// llamada al DO, enteras y como valor, antes de que nadie las escriba, así que parar de escribir
// no evita haberlas traído. Lo que acota esa llamada es su propio tope de 32 MiB, y por eso el
// techo queda por debajo de él.

import type { Client, ResultSet } from "@libsql/client/web";

import { parseClientNow, rewriteNowInSql } from "../../durableObjects/tenantHub.tiempo";
import { hubLocal } from "../../lib/hubLocal";
import { tenantQuery, type ContextoDeLectura } from "../../lib/tenantClient";

/**
 * Techo de una respuesta de volcado, en bytes de JSON sin comprimir. Va además del tope de filas
 * de la fase 1: manda el que antes se alcance.
 *
 * Son 24 MiB por cuatro cosas que se miden en bytes y no en filas:
 *
 * - **La memoria del TenantHub**: 128 MB, con el negocio entero dentro. Lo escrito ocupa su tamaño
 *   una vez, y dos durante el instante en que se junta; con 24 MiB caben dos volcados a la vez (una
 *   recuperación y el contraste diario) con holgura.
 * - **El tope de 32 MiB de una llamada entre el Worker y el DO.** El cuerpo de la respuesta de una
 *   ruta que se ejecuta dentro del DO viaja como flujo y no lo tiene (comprobado en local con
 *   40 MiB), pero con la ruta en el Worker las filas vuelven como valor de `consultar`, que sí.
 *   Por debajo de 32 MiB valen las dos formas.
 * - **La Main**, que descarga la respuesta entera con un plazo total de 20 s (`HTTP_TIMEOUT_SECS`,
 *   `tpv-infra-licensing`) y la monta en memoria antes de restaurarla. 24 MiB en 20 s son 10 Mbit/s
 *   sin comprimir.
 * - **Lo que cabe.** Medido con un bar de mil comandas diarias (unas 22.500 filas y 4 MB al día),
 *   una fila ocupa unos 180 bytes: son unas 140.000 filas, seis días de ese bar o un mes de uno
 *   con la sexta parte de movimiento.
 */
export const VOLCADO_MAX_BYTES = 24 * 1024 * 1024;

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

function* posicionales(filas: Iterable<unknown>, columnas: string[]): Generator<unknown[]> {
	for (const fila of filas) {
		yield Array.isArray(fila)
			? fila
			: columnas.map((col) => (fila as Record<string, unknown>)[col] ?? null);
	}
}

function* delLote(lote: ResultSet[]): Generator<Resultado> {
	for (const rs of lote) {
		const columnas = (rs.columns ?? []).map(String);
		yield { columnas, filas: posicionales(rs.rows ?? [], columnas) };
	}
}

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

/** El lector sobre un `Client`: un lote de lectura, que da la foto, y sus filas ya montadas. */
export function lectorDelCliente(db: Pick<Client, "batch">): Lector {
	return {
		foto: async (sentencias, usar) => usar(delLote(await db.batch(sentencias as any, "read"))),
	};
}

/**
 * El lector de la petición en curso: el SQLite de al lado si la ruta se ejecuta dentro del
 * TenantHub del negocio, y `tenantQuery` si no. En los dos, «ahora» es el de quien pregunta
 * (REV-03): `tenantQuery` lo fija por su cuenta y aquí se fija igual, con la misma función.
 */
export function lectorDe(c: ContextoDeLectura): Lector {
	return {
		async foto(sentencias, usar) {
			const local = hubLocal(c.get("tenantId"));
			if (!local) return tenantQuery(c, (db) => lectorDelCliente(db).foto(sentencias, usar));
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

/**
 * Lo que ocupa un texto en UTF-8, sin codificarlo: un byte por carácter ASCII, dos hasta U+07FF,
 * tres en el resto del plano básico y cuatro por cada par de sustitutos.
 */
export function bytesDe(texto: string): number {
	let bytes = texto.length;
	for (let i = 0; i < texto.length; i++) {
		const c = texto.charCodeAt(i);
		if (c < 0x80) continue;
		if (c < 0x800) {
			bytes += 1;
		} else if (c >= 0xd800 && c <= 0xdbff && (texto.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
			// Un par: dos unidades de UTF-16 que son cuatro bytes.
			bytes += 2;
			i++;
		} else {
			bytes += 2;
		}
	}
	return bytes;
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
		this.bytes += bytesDe(t);
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
