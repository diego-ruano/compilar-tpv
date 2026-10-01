// src/server/copiaBaseCentral.ts
//
// PROD-02 · Copia diaria de la base central (control-plane) a R2. La lanza el cron
// (`index.ts::programado`); no hay ninguna ruta que la dispare.
//
// Por qué hace falta aunque Turso tenga PITR: el PITR del plan Free sólo llega a 24 h atrás (lo que
// se descubre al tercer día ya no tiene arreglo), no recupera una base BORRADA y vive en el mismo
// proveedor que se quiere proteger. Esta copia cubre esos tres casos, y la de Turso cubre el minuto
// a minuto que ésta no tiene. Son complementarias: ninguna sustituye a la otra.
//
// Y por qué importa tanto esta base en concreto: si el worker contesta `license_not_found`, el TPV
// borra su licencia local (`tpv-infra-licensing::clasificar_error`). Perder `licenses` y `devices`
// no es perder un histórico: es que todos los equipos se desactivan en la siguiente comprobación.
//
// Reglas al tocarlo:
//   · SÓLO LEE. El worker no cambia la estructura de esta base (docs/arquitectura/worker.md), y la copia tampoco
//     escribe filas: es un `SELECT` por tabla dentro de una transacción de lectura.
//   · Una transacción de lectura para todo, y no una consulta suelta por tabla, porque las tablas se
//     apuntan entre sí (una licencia a su tenant, un dispositivo a su tenant): leídas en momentos
//     distintos, la copia podría tener una sin la otra. En WAL no bloquea a nadie.
//   · El techo va en la copia ENTERA, no en cada tabla (la regla de REV-21): se construye en memoria
//     y un isolate tiene 128 MB. Pasado `TOPE_CARACTERES` falla en voz alta —y el latido de la copia
//     deja de sonar— en vez de reventar el isolate a medias. Hoy la base ocupa una fracción mínima
//     de eso; el día que se acerque, esto pasa a subir por partes (multipart de R2).
//   · El formato es el de `sqlite3 .dump`, para poder restaurarlo sin nuestro código:
//     `turso db create <nombre> --from-dump copia.sql`, o `sqlite3 local.db < copia.sql` para mirarla.
//   · El bucket es PRIVADO y propio. Nunca `tpv-images`, que es público por `r2.dev`: esto lleva los
//     correos de los clientes, y las DEK y los tokens de Turso (cifrados con `LICENSE_STORE_KEY`,
//     que por eso tiene que estar guardada fuera de Cloudflare: sin ella la copia no los devuelve).
//   · Cuánto se guardan las copias lo decide la regla de ciclo de vida del bucket, no este código.
//     Tiene que ser menor que los 90 días de `RETENCION_ENVIOS_MS` (purga.ts), o los correos que la
//     purga promete olvidar seguirían vivos dentro de las copias.

import type { Client, Transaction } from "@libsql/client/web";

/** Filas por consulta. Pocas peticiones para una base pequeña, sin traer una tabla entera de golpe. */
const FILAS_POR_PAGINA = 500;

/** El techo de la copia sin comprimir, en caracteres. Ver la cabecera. */
export const TOPE_CARACTERES = 64 * 1024 * 1024;

/** Dónde caen las copias dentro del bucket. Una por día: repetir el cron el mismo día la reescribe. */
export const PREFIJO_COPIAS = "base-central/";

/**
 * Tablas que no son nuestras: las internas de SQLite, las de Turso y las del SQLite de un Durable
 * Object (en los tests, la base central vive en uno). Todo lo demás se copia, también una tabla que
 * se cree mañana: callarse una tabla nueva es justo el fallo que una copia no puede tener.
 */
const AJENAS = /^(sqlite_|_cf_|libsql_|_litestream_)/i;

export type CopiaHecha = {
	clave: string;
	tablas: number;
	filas: number;
	bytes: number;
};

type Opciones = {
	ahoraMs?: number;
	/** Sólo para los tests: cuándo se considera demasiado grande. */
	topeCaracteres?: number;
};

/** Copia la base central entera a `bucket` y devuelve qué se subió. Lanza si algo falla. */
export async function copiarBaseCentral(
	db: Pick<Client, "transaction">,
	bucket: R2Bucket,
	opciones: Opciones = {},
): Promise<CopiaHecha> {
	const ahora = new Date(opciones.ahoraMs ?? Date.now());
	const volcado = await volcar(db, ahora, opciones.topeCaracteres ?? TOPE_CARACTERES);

	const comprimido = await gzip(volcado.trozos);
	const clave = `${PREFIJO_COPIAS}${ahora.toISOString().slice(0, 10)}.sql.gz`;

	await bucket.put(clave, comprimido, {
		httpMetadata: { contentType: "application/gzip" },
		customMetadata: {
			generada: ahora.toISOString(),
			tablas: String(volcado.tablas),
			filas: String(volcado.filas),
		},
		// R2 recalcula el hash al recibirlo y rechaza la subida si no coincide.
		sha256: await crypto.subtle.digest("SHA-256", comprimido),
	});

	return { clave, tablas: volcado.tablas, filas: volcado.filas, bytes: comprimido.byteLength };
}

type Volcado = { trozos: string[]; tablas: number; filas: number };

async function volcar(db: Pick<Client, "transaction">, ahora: Date, tope: number): Promise<Volcado> {
	const trozos: string[] = [];
	let caracteres = 0;
	const escribir = (linea: string) => {
		caracteres += linea.length + 1;
		if (caracteres > tope) {
			throw new Error(`copia_demasiado_grande: supera ${tope} caracteres sin comprimir`);
		}
		trozos.push(linea, "\n");
	};

	escribir("-- Copia de la base central de tpv-api (control-plane). PROD-02.");
	escribir(`-- Generada: ${ahora.toISOString()}`);
	escribir("-- Restaurar: turso db create <nombre-nuevo> --from-dump <este fichero, descomprimido>");
	escribir("PRAGMA foreign_keys=OFF;");
	escribir("BEGIN TRANSACTION;");

	let tablas = 0;
	let filas = 0;

	const tx = await db.transaction("read");
	try {
		const esquema = await tx.execute(
			`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL;`,
		);
		const objetos = esquema.rows
			.map((r: any) => ({
				tipo: String(r.type),
				nombre: String(r.name),
				tabla: String(r.tbl_name),
				sql: String(r.sql),
			}))
			.filter((o) => !AJENAS.test(o.nombre) && !AJENAS.test(o.tabla));

		// Primero cada tabla con sus filas; los índices, vistas y triggers al final, como hace
		// `sqlite3 .dump`: crear un índice sobre la tabla llena es más rápido que mantenerlo fila a
		// fila, y un trigger creado antes de los INSERT se dispararía al restaurar.
		for (const t of objetos.filter((o) => o.tipo === "table")) {
			escribir(`${t.sql};`);
			tablas++;
			filas += await volcarFilas(tx, t.nombre, escribir);
		}
		for (const o of objetos.filter((o) => o.tipo !== "table")) {
			escribir(`${o.sql};`);
		}
	} finally {
		// Una transacción de lectura no tiene nada que confirmar: cerrarla la deshace.
		tx.close();
	}

	escribir("COMMIT;");
	return { trozos, tablas, filas };
}

async function volcarFilas(
	tx: Pick<Transaction, "execute">,
	tabla: string,
	escribir: (linea: string) => void,
): Promise<number> {
	const nombre = identificador(tabla);
	let desde = Number.MIN_SAFE_INTEGER;
	let total = 0;

	// Se pagina por `rowid`, que existe en todas las tablas de esta base y es una sola columna
	// (el mismo motivo que en `/v1/sync/historico`, SYNC-19). Se pide aparte, con un alias que no
	// puede chocar con una columna real, y no entra en el INSERT: la clave de la fila ya va en sus
	// columnas.
	for (;;) {
		const r = await tx.execute({
			sql: `SELECT rowid AS "__copia_rowid", * FROM ${nombre} WHERE rowid > ? ORDER BY rowid LIMIT ?;`,
			args: [desde, FILAS_POR_PAGINA],
		});
		const columnas = r.columns.filter((c) => c !== "__copia_rowid");
		const lista = columnas.map(identificador).join(", ");

		for (const fila of r.rows as any[]) {
			const valores = columnas.map((c) => literal(fila[c])).join(", ");
			escribir(`INSERT INTO ${nombre} (${lista}) VALUES (${valores});`);
			desde = Number(fila.__copia_rowid);
			total++;
		}
		if (r.rows.length < FILAS_POR_PAGINA) return total;
	}
}

function identificador(nombre: string): string {
	return `"${nombre.replaceAll('"', '""')}"`;
}

/**
 * Un valor de SQLite escrito como literal SQL. Exportada para los tests: lo que importa de esta
 * función son sus casos raros, y se prueban mejor directamente.
 */
export function literal(v: unknown): string {
	if (v === null || v === undefined) return "NULL";
	if (typeof v === "bigint") return v.toString();
	if (typeof v === "boolean") return v ? "1" : "0";
	if (typeof v === "number") {
		// Un NaN o un infinito no tiene literal en SQL. No debería salir nunca de SQLite, y si sale,
		// escribir NULL en su lugar sería una copia que miente sin decirlo.
		if (!Number.isFinite(v)) throw new Error(`copia_valor_no_finito: ${v}`);
		return String(v);
	}
	if (typeof v === "string") {
		// Un NUL no puede ir dentro de un literal de texto: SQLite cortaría la cadena ahí. Se
		// escribe en hexadecimal y se vuelve a convertir en texto.
		if (v.includes("\0")) return `CAST(X'${hex(new TextEncoder().encode(v))}' AS TEXT)`;
		return `'${v.replaceAll("'", "''")}'`;
	}
	if (v instanceof ArrayBuffer) return `X'${hex(new Uint8Array(v))}'`;
	if (ArrayBuffer.isView(v)) {
		return `X'${hex(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))}'`;
	}
	throw new Error(`copia_valor_desconocido: ${typeof v}`);
}

function hex(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += b.toString(16).padStart(2, "0");
	return s;
}

async function gzip(trozos: string[]): Promise<Uint8Array> {
	const flujo = new Blob(trozos).stream().pipeThrough(new CompressionStream("gzip"));
	return new Uint8Array(await new Response(flujo).arrayBuffer());
}
