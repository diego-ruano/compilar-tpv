// src/durableObjects/tenantHub.copia.ts
//
// DO-03 · La copia diaria de la base de un negocio, fuera de su objeto.
//
// La base del negocio vive en el SQLite de su TenantHub, y Cloudflare la puede devolver a cualquier
// instante de los últimos 30 días (`tenantHub.instante.ts`). Eso no cubre que el objeto se pierda
// (un `borrarTodo` por error, otro espacio de nombres, el propio proveedor): para eso está esta copia,
// que cada TenantHub hace de sí mismo una vez al día con su alarma (`MotorTenantHub.alarma`) y deja
// en un bucket R2 privado propio (`COPIAS_NEGOCIOS`). No hay un bucle en el cron que recorra los
// negocios: con miles no cabría en su plazo, y cada objeto ya tiene su base al lado.
//
// Reglas al tocarlo:
//   · **Una foto de la base.** Todo se lee de una pasada y sin esperas: el SQL del DO es síncrono y
//     un negocio es un hilo, así que mientras se lee no se intercala ninguna escritura y la copia no
//     puede tener una línea sin su comanda. Por eso se comprime también aquí, a trozos y sin
//     esperas (`node:zlib`); sólo la subida a R2, que ya es de lo leído, espera a la red.
//   · **Sólo las tablas del negocio** (`esTablaDeNegocio`, la misma lista que el volcado de la
//     recuperación): ni las que empiezan por `_` (el sello, la Main vigente, el resumen de las
//     estadísticas, `_migrations`), ni el andamiaje de la réplica (`Sync_Changes`,
//     `Applied_Operations`, `Sync_Main_Checkpoints`), ni el freno del PIN. Del log sólo va hasta
//     dónde numeró (`seq`, en los metadatos del objeto de R2): sobrevive a perder el objeto, y es con
//     lo que se abre por encima el log de una base devuelta (DO-PERDIDA, `seqDeLasCopias`).
//   · **Legible sin nuestro código**: es un volcado SQL comprimido con gzip, como el de la base
//     central (`server/copiaBaseCentral.ts`). `gunzip -c copia.sql.gz | sqlite3 copia.db` la abre.
//     Cada sentencia de datos va en una línea (un salto de línea dentro de un texto se escribe como
//     `char(10)`), y es lo que permite restaurarla leyéndola por líneas (`cargarCopia`).
//   · **Datos personales**: clientes, personal, reservas. El bucket es privado y no es el de las
//     imágenes, y nada de la copia sale en un log: las trazas llevan la clave, las filas y los bytes.
//   · **Cuántas se guardan lo decide este código** (`COPIAS_QUE_SE_GUARDAN`), no una regla de ciclo
//     de vida del bucket: una regla por antigüedad borraría también las últimas copias de un negocio
//     cuyo objeto se ha perdido (ya no hace copias nuevas), que son justo las que hacen falta.

import { constants, crc32, deflateRawSync } from "node:zlib";

import { esTablaDeNegocio } from "../domains/sync/bootstrap.ventana";
import { seqMasAlto } from "./tenantHub.instante";

/** Dónde caen las copias de los negocios dentro de su bucket: `negocios/<negocio>/<día>.sql.gz`. */
export const PREFIJO_COPIAS_NEGOCIOS = "negocios/";

/**
 * Cuántas copias diarias se guardan de cada negocio: las de los últimos 30 días, lo mismo que llega
 * la vuelta a un instante de Cloudflare. Más atrás no se restaura (`Sync_Changes` sólo guarda 7 días
 * y la Main tendría que traerse la nube entera), y son datos personales que no hace falta guardar.
 */
export const COPIAS_QUE_SE_GUARDAN = 30;

/**
 * El techo de la copia comprimida, que se monta en memoria antes de subirla (un objeto tiene
 * 128 MB). Un volcado SQL de una base de un bar se comprime entre 8 y 12 veces: son varios cientos de
 * MB sin comprimir, años de un bar normal. Pasado el techo falla en voz alta (Sentry y Axiom) en vez
 * de reventar el objeto; el día que se acerque, lo que toca es archivar lo antiguo (DB-14).
 */
export const TOPE_COMPRIMIDO = 64 * 1024 * 1024;

/** Cada cuántos caracteres sin comprimir se comprime un trozo. */
const TROZO_CARACTERES = 1024 * 1024;

/** La primera línea de los datos de cada tabla. Es lo único que se ejecuta al restaurar. */
export const PRINCIPIO_DE_INSERT = 'INSERT INTO "';
/** La línea que dice con qué migraciones se hizo la copia. */
export const LINEA_MIGRACIONES = "-- Migraciones: ";
/** La línea del final: sin ella, la copia está cortada. */
export const LINEA_FIN = "-- Fin de la copia: ";

/** El prefijo de las copias de un negocio. Acaba en `/`: no es el principio del de otro. */
export function prefijoDeCopias(tenantId: string): string {
	if (!tenantId || tenantId.includes("/")) throw new Error("tenant_id_invalido");
	return `${PREFIJO_COPIAS_NEGOCIOS}${tenantId}/`;
}

/** La clave de la copia de un día (`AAAA-MM-DD`, en UTC). Repetir la del mismo día la reescribe. */
export function claveDeCopia(tenantId: string, dia: string): string {
	return `${prefijoDeCopias(tenantId)}${dia}.sql.gz`;
}

export type VolcadoDelNegocio = {
	/** El fichero entero, en gzip. */
	gzip: Uint8Array;
	tablas: number;
	filas: number;
	/** Bytes del SQL sin comprimir. */
	bytesSinComprimir: number;
	/** Las migraciones aplicadas a la base, en orden: con qué esquema se hizo. */
	migraciones: string[];
	/**
	 * DO-PERDIDA · El `Seq` más alto que sabía la base al copiarla (`seqMasAlto`). El log no va en la
	 * copia, pero hasta dónde numeró sí, en sus metadatos (`seqDeLasCopias`): sobrevive a perder el
	 * objeto, y es parte de lo que dice desde dónde abrir el log de su base nueva.
	 */
	seq: number;
};

/**
 * Lee la base entera del negocio y la deja comprimida en memoria. Síncrona a propósito: es lo que la
 * hace una foto (ver la cabecera). Lanza si la base no está aprovisionada o la copia pasa del techo.
 */
export function volcarNegocio(
	sql: SqlStorage,
	opciones: { tenantId: string; ahora: Date; topeComprimido?: number },
): VolcadoDelNegocio {
	const tope = opciones.topeComprimido ?? TOPE_COMPRIMIDO;
	const gz = new GzipPorTrozos(tope);

	const migraciones = (sql.exec("SELECT name FROM _migrations ORDER BY rowid;").toArray() as { name: string }[]).map(
		(f) => String(f.name),
	);
	const seq = seqMasAlto(sql);
	const esquema = sql
		.exec("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid;")
		.toArray() as { type: string; name: string; tbl_name: string; sql: string }[];
	const tablas = esquema.filter((o) => o.type === "table" && esTablaDeNegocio(o.name));
	const indices = esquema.filter((o) => o.type === "index" && esTablaDeNegocio(o.tbl_name));

	gz.linea(`-- Copia de la base del negocio ${opciones.tenantId} (tpv-api, DO-03).`);
	gz.linea(`-- Generada: ${opciones.ahora.toISOString()}`);
	gz.linea(`${LINEA_MIGRACIONES}${migraciones.join(",")}`);
	gz.linea("-- Sólo las tablas del negocio: sin las que empiezan por _, sin el log de sincronización ni");
	gz.linea("-- los intentos de PIN. Sin vistas ni disparadores, que son del esquema (las migraciones).");
	gz.linea("-- Abrirla: gunzip -c <copia>.sql.gz | sqlite3 copia.db");
	gz.linea("-- Devolverla a su TenantHub: docs/guias/restaurar-un-negocio.md");
	gz.linea("PRAGMA foreign_keys=OFF;");
	gz.linea("BEGIN TRANSACTION;");
	for (const t of tablas) gz.linea(`${t.sql};`);

	let filas = 0;
	for (const t of tablas) filas += volcarFilas(sql, t.name, gz);

	// Los índices después de los datos, como `sqlite3 .dump`: crearlos sobre la tabla llena es más
	// rápido que mantenerlos fila a fila.
	for (const i of indices) gz.linea(`${i.sql};`);
	gz.linea(`${LINEA_FIN}${filas} filas en ${tablas.length} tablas`);
	gz.linea("COMMIT;");

	const { gzip, bytesSinComprimir } = gz.cerrar();
	return { gzip, tablas: tablas.length, filas, bytesSinComprimir, migraciones, seq };
}

/** Las filas de una tabla, una sentencia por línea. El cursor se recorre entero (worker.md). */
function volcarFilas(sql: SqlStorage, tabla: string, gz: GzipPorTrozos): number {
	const nombre = identificador(tabla);
	const cursor = sql.exec(`SELECT * FROM ${nombre};`);
	const lista = cursor.columnNames.map(identificador).join(", ");
	const principio = `INSERT INTO ${nombre} (${lista}) VALUES (`;
	let n = 0;
	for (const fila of cursor.raw()) {
		gz.linea(`${principio}${(fila as unknown[]).map(literalEnUnaLinea).join(", ")});`);
		n++;
	}
	return n;
}

export function identificador(nombre: string): string {
	return `"${nombre.replaceAll('"', '""')}"`;
}

/**
 * Un valor de SQLite como literal SQL que cabe en una línea. Como `literal` de la copia de la base
 * central, pero un salto de línea dentro de un texto se escribe como `char(10)` (y el retorno de
 * carro, `char(13)`): cada sentencia de datos es una línea, y así se lee al restaurar.
 */
export function literalEnUnaLinea(v: unknown): string {
	if (v === null || v === undefined) return "NULL";
	if (typeof v === "bigint") return v.toString();
	if (typeof v === "boolean") return v ? "1" : "0";
	if (typeof v === "number") {
		// Un NaN o un infinito no tiene literal en SQL, y escribir NULL en su lugar sería una copia
		// que miente sin decirlo.
		if (!Number.isFinite(v)) throw new Error(`copia_valor_no_finito: ${v}`);
		return String(v);
	}
	if (typeof v === "string") {
		// Un NUL no puede ir dentro de un literal de texto: SQLite cortaría la cadena ahí.
		if (v.includes("\0")) return `CAST(X'${hex(new TextEncoder().encode(v))}' AS TEXT)`;
		const escapado = `'${v.replaceAll("'", "''")}'`;
		if (!/[\r\n]/.test(v)) return escapado;
		return `(${escapado.replaceAll("\n", "'||char(10)||'").replaceAll("\r", "'||char(13)||'")})`;
	}
	if (v instanceof ArrayBuffer) return `X'${hex(new Uint8Array(v))}'`;
	if (ArrayBuffer.isView(v)) return `X'${hex(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))}'`;
	throw new Error(`copia_valor_desconocido: ${typeof v}`);
}

function hex(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += b.toString(16).padStart(2, "0");
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
 */
class GzipPorTrozos {
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

export type CopiaHecha = {
	clave: string;
	tablas: number;
	filas: number;
	/** Bytes de la copia comprimida. */
	bytes: number;
	/** Copias viejas borradas al hacer ésta. */
	podadas: number;
};

/** Sube la copia de hoy, borra las que pasan de `COPIAS_QUE_SE_GUARDAN` y dice qué ha hecho. */
export async function subirCopia(
	bucket: R2Bucket,
	tenantId: string,
	volcado: VolcadoDelNegocio,
	ahora: Date,
	/** DO-SUBIDA: las copias de antes de este instante no se podan (`copiasProtegidasDesde`). */
	protegerAntesDeMs: number | null = null,
): Promise<CopiaHecha> {
	const clave = claveDeCopia(tenantId, ahora.toISOString().slice(0, 10));
	await bucket.put(clave, volcado.gzip, {
		httpMetadata: { contentType: "application/gzip" },
		customMetadata: {
			generada: ahora.toISOString(),
			tablas: String(volcado.tablas),
			filas: String(volcado.filas),
			sinComprimir: String(volcado.bytesSinComprimir),
			ultimaMigracion: volcado.migraciones.at(-1) ?? "",
			seq: String(volcado.seq),
		},
		// R2 recalcula el hash al recibirlo y rechaza la subida si no coincide.
		sha256: await crypto.subtle.digest("SHA-256", volcado.gzip),
	});
	const podadas = await podarCopias(bucket, tenantId, COPIAS_QUE_SE_GUARDAN, protegerAntesDeMs);
	return { clave, tablas: volcado.tablas, filas: volcado.filas, bytes: volcado.gzip.byteLength, podadas };
}

export type CopiaGuardada = {
	clave: string;
	/** El día de la copia, `AAAA-MM-DD`. */
	dia: string;
	bytes: number;
	subida: string;
};

/** Las copias de un negocio, de la más nueva a la más vieja. */
export async function listarCopias(bucket: R2Bucket, tenantId: string): Promise<CopiaGuardada[]> {
	const prefix = prefijoDeCopias(tenantId);
	const copias: CopiaGuardada[] = [];
	let cursor: string | undefined;
	do {
		const pagina = await bucket.list({ prefix, cursor, limit: 1000 });
		for (const o of pagina.objects) {
			const dia = o.key.slice(prefix.length).replace(/\.sql\.gz$/, "");
			copias.push({ clave: o.key, dia, bytes: o.size, subida: o.uploaded.toISOString() });
		}
		cursor = pagina.truncated ? pagina.cursor : undefined;
	} while (cursor);
	// Las claves llevan el día con ceros delante: el orden de las letras es el de las fechas.
	return copias.sort((a, b) => (a.clave < b.clave ? 1 : a.clave > b.clave ? -1 : 0));
}

/**
 * DO-PERDIDA · El `Seq` más alto que dicen las copias de un negocio (el `seq` de sus metadatos, que
 * apunta `subirCopia`), o 0 si ninguna lo dice. Lo lee la administración antes de abrir el log de
 * una base devuelta (`basesDeNegocios.ts`): un objeto que lo ha perdido todo no recuerda hasta dónde
 * numeró, y sus copias sí.
 */
export async function seqDeLasCopias(bucket: R2Bucket, tenantId: string): Promise<number> {
	const prefix = prefijoDeCopias(tenantId);
	let maximo = 0;
	let cursor: string | undefined;
	do {
		const pagina = await bucket.list({ prefix, cursor, limit: 1000, include: ["customMetadata"] });
		for (const o of pagina.objects) {
			const seq = Number(o.customMetadata?.seq);
			if (Number.isSafeInteger(seq) && seq > maximo) maximo = seq;
		}
		cursor = pagina.truncated ? pagina.cursor : undefined;
	} while (cursor);
	return maximo;
}

/**
 * Borra las copias de un negocio que pasan de las `guardar` más nuevas. Devuelve cuántas.
 *
 * DO-SUBIDA: con `protegerAntesDeMs`, las de un día anterior a ese instante se quedan: mientras la
 * Main no ha subido su base a una nube devuelta, las copias de antes de la pérdida son las buenas.
 */
export async function podarCopias(
	bucket: R2Bucket,
	tenantId: string,
	guardar: number = COPIAS_QUE_SE_GUARDAN,
	protegerAntesDeMs: number | null = null,
): Promise<number> {
	const diaProtegido = protegerAntesDeMs === null ? null : new Date(protegerAntesDeMs).toISOString().slice(0, 10);
	const sobran = (await listarCopias(bucket, tenantId))
		.slice(guardar)
		.filter((c) => diaProtegido === null || c.dia >= diaProtegido)
		.map((c) => c.clave);
	if (sobran.length) await bucket.delete(sobran);
	return sobran.length;
}

/** Borra todas las copias de un negocio (al retirarlo). Devuelve cuántas. */
export async function borrarCopias(bucket: R2Bucket, tenantId: string): Promise<number> {
	return podarCopias(bucket, tenantId, 0);
}

/**
 * Cuándo toca la siguiente copia: la madrugada siguiente, entre las 3:00 y las 5:00 UTC (de 4 a 6
 * de la mañana en la península en invierno, de 5 a 7 en verano), cuando un bar está cerrado y la
 * copia, que ocupa el hilo del negocio mientras lee, no estorba. Cada negocio a su minuto, sacado
 * de su nombre, para que miles no lleguen a R2 a la vez.
 */
export function siguienteCopiaMs(tenantId: string, ahoraMs: number): number {
	let h = 0;
	for (let i = 0; i < tenantId.length; i++) h = (h * 31 + tenantId.charCodeAt(i)) >>> 0;
	const minuto = h % 120;
	const dia = new Date(ahoraMs);
	let cuando = Date.UTC(dia.getUTCFullYear(), dia.getUTCMonth(), dia.getUTCDate(), 3, minuto);
	if (cuando <= ahoraMs) cuando += 24 * 60 * 60 * 1000;
	return cuando;
}
