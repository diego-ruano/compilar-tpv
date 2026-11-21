// src/domains/sync/resumenCubos.ts
//
// El resumen por cubos con el que la nube y la Main comparan sus filas sin mandárselas.
//
// El contraste diario tiene que decir si las filas de la ventana son las mismas en los dos sitios, y
// bajarlas enteras no escala: la ventana de un bar con mucho movimiento no cabe en una respuesta.
// Cada lado resume las suyas:
//
// - cada fila va a un cubo, que sale del hash de su clave primaria (`cubo256`);
// - de cada cubo se guarda cuántas filas tiene y la suma (módulo 2⁶⁴) del hash de cada una.
//
// Dos cubos con la misma cuenta y la misma suma tienen las mismas filas; de uno que no cuadra se
// bajan sus filas (`/v1/sync/verificar/filas`) y la Main las compara una a una.
//
// Es el gemelo de `crates/tpv-domain/src/contraste.rs`, donde está el porqué de cada decisión. No
// comparten código: comparten la tabla de casos `crates/tpv-domain/src/verificacion_casos.json`
// (`test/resumenCubos.test.ts`). Un criterio nuevo es un caso nuevo ahí.
//
// La forma canónica de una fila es la concatenación de sus valores, en el orden de sus columnas:
//
//   NULL                    00
//   un número               01 + sus 8 bytes IEEE-754 de doble, en big-endian (-0 es +0)
//   un texto                02 + su longitud en bytes (u32 big-endian) + su UTF-8
//   un blob                 03 + su longitud (u32 big-endian) + sus bytes
//
// El hash es FNV-1a de 64 bits, con aritmética de 32: aquí no hay enteros de 64 bits, y el resumen
// se calcula sin soltar el hilo (el SQL del DO es síncrono), que es lo que lo hace una foto.
// `crypto.subtle` es asíncrono y no sirve para eso. El cubo no sale de él tal cual: se mezcla antes
// con el `fmix32` de MurmurHash3 (`cubo256`), porque FNV-1a apenas lleva a sus bits altos lo que
// cambia al final de una clave.

/** El máximo de cubos de una tabla. Es también con los que se calcula: después se pliegan. */
export const MAX_CUBOS = 256;

/** Las filas que se buscan por cubo: de ahí sale cuántos cubos lleva cada tabla. */
const FILAS_POR_CUBO = 32;

/**
 * Cuántos cubos lleva una tabla de `filas` filas: la menor potencia de dos que deja unas 32 por
 * cubo, hasta 256. Una maestra de veinte filas va en uno; cualquiera de más de 4.096, en 256.
 *
 * Lo decide la nube y viaja en el resumen. La Main usa el número que le llega.
 */
export function cubosPara(filas: number): number {
	let cubos = 1;
	while (cubos < MAX_CUBOS && cubos * FILAS_POR_CUBO < filas) cubos *= 2;
	return cubos;
}

/** ¿Es un número de cubos que se puede usar? Una potencia de dos entre 1 y `MAX_CUBOS`. */
export function cubosValidos(cubos: unknown): cubos is number {
	return (
		typeof cubos === "number" &&
		Number.isInteger(cubos) &&
		cubos >= 1 &&
		cubos <= MAX_CUBOS &&
		(cubos & (cubos - 1)) === 0
	);
}

/** Cuánto hay que desplazar un cubo de 256 para dejarlo en uno de `cubos`. */
function plegado(cubos: number): number {
	return 8 - Math.log2(cubos);
}

/**
 * FNV-1a de 64 bits de los `n` primeros bytes. Deja en `salida` sus dos mitades de 32 bits: la
 * alta en `[0]` y la baja en `[1]`.
 *
 * El estado son esas dos mitades. Multiplicar por el primo (2⁴⁰ + 0x1b3) es sumar la mitad baja
 * desplazada 40 bits —que cae entera en la alta, 8 bits más arriba— y multiplicar por 0x1b3, que se
 * hace en dos trozos de 16 bits para que ningún producto pase de 2³².
 */
export function fnv1a64(bytes: Uint8Array, n: number, salida: Uint32Array): void {
	let alto = 0xcbf29ce4 | 0;
	let bajo = 0x84222325 | 0;
	for (let i = 0; i < n; i++) {
		bajo ^= bytes[i];
		const t = (bajo & 0xffff) * 0x1b3;
		const u = (bajo >>> 16) * 0x1b3 + (t >>> 16);
		alto = (Math.imul(alto, 0x1b3) + (bajo << 8) + (u >>> 16)) | 0;
		bajo = ((u & 0xffff) << 16) | (t & 0xffff);
	}
	salida[0] = alto;
	salida[1] = bajo;
}

// Sin estado: lo que codifica lo escribe en el búfer que se le da.
const CODIFICADOR = new TextEncoder();

/**
 * Escribe la forma canónica de unos valores y calcula su FNV-1a de 64 bits.
 *
 * Un solo búfer, que crece si hace falta: resumir una tabla no reserva memoria por fila.
 */
export class Canonico {
	private bytes = new Uint8Array(4096);
	private vista = new DataView(this.bytes.buffer);
	private n = 0;

	private readonly mitades = new Uint32Array(2);

	/** La mitad alta del último hash, sin signo. */
	get alto(): number {
		return this.mitades[0];
	}

	/** La mitad baja del último hash, sin signo. */
	get bajo(): number {
		return this.mitades[1];
	}

	vaciar(): void {
		this.n = 0;
	}

	/** Lo escrito desde el último `vaciar`. Es una vista del búfer: vale hasta la escritura siguiente. */
	escrito(): Uint8Array {
		return this.bytes.subarray(0, this.n);
	}

	private sitio(mas: number): void {
		if (this.n + mas <= this.bytes.length) return;
		const nuevo = new Uint8Array(Math.max(this.bytes.length * 2, this.n + mas));
		nuevo.set(this.bytes.subarray(0, this.n));
		this.bytes = nuevo;
		this.vista = new DataView(nuevo.buffer);
	}

	private blob(b: Uint8Array): void {
		this.sitio(5 + b.length);
		this.bytes[this.n] = 3;
		this.vista.setUint32(this.n + 1, b.length);
		this.bytes.set(b, this.n + 5);
		this.n += 5 + b.length;
	}

	/** Añade un valor tal como lo entrega el SQLite del DO: `null`, número, texto o `ArrayBuffer`. */
	valor(v: unknown): void {
		if (v === null || v === undefined) {
			this.sitio(1);
			this.bytes[this.n++] = 0;
			return;
		}
		switch (typeof v) {
			case "number":
				this.sitio(9);
				this.bytes[this.n] = 1;
				// `-0 === 0`: los dos se escriben como +0.
				this.vista.setFloat64(this.n + 1, v === 0 ? 0 : v);
				this.n += 9;
				return;
			case "string": {
				// Como mucho tres bytes por unidad de UTF-16 (un par de sustitutos son cuatro por dos).
				this.sitio(5 + v.length * 3);
				const { written } = CODIFICADOR.encodeInto(v, this.bytes.subarray(this.n + 5));
				this.bytes[this.n] = 2;
				this.vista.setUint32(this.n + 1, written);
				this.n += 5 + written;
				return;
			}
			case "boolean":
				this.valor(v ? 1 : 0);
				return;
			case "bigint":
				this.valor(Number(v));
				return;
		}
		if (v instanceof ArrayBuffer) return this.blob(new Uint8Array(v));
		if (ArrayBuffer.isView(v)) return this.blob(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
		throw new Error("resumenCubos: un valor que SQLite no guarda");
	}

	/** Calcula el FNV-1a de 64 bits de lo escrito: queda en `alto` y `bajo`. */
	hash(): void {
		fnv1a64(this.bytes, this.n, this.mitades);
	}
}

/**
 * El cubo entre 256 de una fila, a partir del hash de su clave (sus dos mitades): las dos juntas con
 * XOR, mezcladas con el `fmix32` de MurmurHash3, y de eso los 8 bits altos. Entre menos cubos son
 * los bits altos de éste.
 */
function cubo256(alto: number, bajo: number): number {
	let h = (alto ^ bajo) | 0;
	h ^= h >>> 16;
	h = Math.imul(h, 0x85ebca6b);
	h ^= h >>> 13;
	h = Math.imul(h, 0xc2b2ae35);
	h ^= h >>> 16;
	return h >>> 24;
}

/** Dieciséis cifras hexadecimales: así viaja un hash o una suma de 64 bits. */
export function hex64(alto: number, bajo: number): string {
	return alto.toString(16).padStart(8, "0") + bajo.toString(16).padStart(8, "0");
}

/**
 * DO-SUBIDA · Las filas de un tramo, resumidas: cuántas son y la suma, módulo 2⁶⁴, de sus huellas
 * (el hash de la fila entera, el mismo de `Resumidor`). No depende del orden. La Main lo calcula igual
 * (`tpv_domain::contraste::suma_de_huellas`); los dos leen `tramos` en `verificacion_casos.json`.
 */
export class SumaDeTramo {
	private readonly canonico = new Canonico();
	private alto = 0;
	private bajo = 0;
	n = 0;

	/** Añade una fila: sus valores tal como los entrega el SQLite del DO. */
	fila(valores: unknown[]): void {
		const c = this.canonico;
		c.vaciar();
		for (const v of valores) c.valor(v);
		c.hash();
		const b = this.bajo + c.bajo;
		this.bajo = b >>> 0;
		this.alto = (this.alto + c.alto + (b > 0xffffffff ? 1 : 0)) >>> 0;
		this.n++;
	}

	/** La suma, en dieciséis cifras hexadecimales. */
	get suma(): string {
		return hex64(this.alto, this.bajo);
	}
}

/** El resumen de una tabla, como viaja: por cubo, cuántas filas y la suma de sus hashes. */
export type ResumenCubos = { cubos: number; cuentas: number[]; sumas: string[] };

/**
 * Resume las filas de una tabla, de una en una.
 *
 * Calcula siempre con 256 cubos y pliega al terminar (`resumen`): el cubo de una fila entre N son
 * los bits altos de su cubo entre 256, así que el número de cubos se puede decidir con las filas ya
 * contadas, sin leerlas dos veces.
 */
export class Resumidor {
	private readonly canonico = new Canonico();
	private readonly cuentas = new Uint32Array(MAX_CUBOS);
	private readonly altos = new Uint32Array(MAX_CUBOS);
	private readonly bajos = new Uint32Array(MAX_CUBOS);
	private total = 0;

	/** Cuántas filas se han apuntado. */
	get filas(): number {
		return this.total;
	}

	/**
	 * Apunta una fila. `claves` son las posiciones, dentro de la fila, de las columnas de su clave
	 * primaria, en el orden de la clave. Devuelve su cubo entre 256.
	 */
	fila(fila: unknown[], claves: number[]): number {
		const c = this.canonico;
		c.vaciar();
		for (let i = 0; i < claves.length; i++) c.valor(fila[claves[i]]);
		c.hash();
		const cubo = cubo256(c.alto, c.bajo);

		c.vaciar();
		for (let i = 0; i < fila.length; i++) c.valor(fila[i]);
		c.hash();

		this.cuentas[cubo]++;
		// La suma de 64 bits, en dos mitades: lo que no cabe en la baja se lleva a la alta. Las
		// asignaciones a un `Uint32Array` se quedan con los 32 bits bajos.
		const bajo = this.bajos[cubo] + c.bajo;
		this.bajos[cubo] = bajo;
		this.altos[cubo] = this.altos[cubo] + c.alto + (bajo > 0xffffffff ? 1 : 0);
		this.total++;
		return cubo;
	}

	/** El resumen plegado a `cubos` (por defecto, los que le tocan por sus filas). */
	resumen(cubos: number = cubosPara(this.total)): ResumenCubos {
		const despl = plegado(cubos);
		const cuentas = new Array<number>(cubos).fill(0);
		const altos = new Uint32Array(cubos);
		const bajos = new Uint32Array(cubos);
		for (let i = 0; i < MAX_CUBOS; i++) {
			const c = i >>> despl;
			cuentas[c] += this.cuentas[i];
			const bajo = bajos[c] + this.bajos[i];
			bajos[c] = bajo;
			altos[c] = altos[c] + this.altos[i] + (bajo > 0xffffffff ? 1 : 0);
		}
		const sumas = new Array<string>(cubos);
		for (let c = 0; c < cubos; c++) sumas[c] = hex64(altos[c], bajos[c]);
		return { cubos, cuentas, sumas };
	}
}

/**
 * Dice de cada fila si su cubo es uno de los pedidos.
 *
 * `pedidos` son cubos entre `cubos`. Lo que no sea un cubo de esa tabla (un índice fuera de rango,
 * algo que no es un entero) no pide nada.
 */
export class FiltroDeCubos {
	private readonly canonico = new Canonico();
	private readonly pedido = new Uint8Array(MAX_CUBOS);
	private readonly despl: number;

	constructor(cubos: number, pedidos: readonly unknown[]) {
		this.despl = plegado(cubos);
		for (const p of pedidos) {
			if (typeof p === "number" && Number.isInteger(p) && p >= 0 && p < cubos) this.pedido[p] = 1;
		}
	}

	/** ¿La fila, cuya clave primaria está en las posiciones `claves`, cae en un cubo pedido? */
	pide(fila: unknown[], claves: number[]): boolean {
		const c = this.canonico;
		c.vaciar();
		for (let i = 0; i < claves.length; i++) c.valor(fila[claves[i]]);
		c.hash();
		return this.pedido[cubo256(c.alto, c.bajo) >>> this.despl] === 1;
	}
}
