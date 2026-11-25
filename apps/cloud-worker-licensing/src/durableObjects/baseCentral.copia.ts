// src/durableObjects/baseCentral.copia.ts
//
// PROD-02 · Las copias de la base central a R2. Las hace el propio objeto (`BaseCentral.copiar`): la
// del día la pide el cron (`index.ts::programado`), una «a mano» la administración
// (`/v1/admin/central/copiar-ahora`), y la de antes de volver a un instante, la propia vuelta
// (`baseCentral.instante.ts`). Se devuelven a un objeto vacío con `baseCentral.restaurar.ts`.
//
// La base vive en el SQLite de su objeto, y Cloudflare la puede devolver a cualquier instante de los
// últimos 30 días. Eso no cubre que el objeto se pierda (un borrado por error, otro nombre, el propio
// proveedor), ni lo que se descubre pasado ese plazo: para eso está esta copia, fuera del objeto.
//
// Y por qué importa tanto esta base en concreto: si el worker contesta `license_not_found`, el TPV
// borra su licencia local (`tpv-infra-licensing::clasificar_error`). Perder `licenses` y `devices`
// no es perder un histórico: es que todos los equipos se desactivan en la siguiente comprobación.
//
// Reglas al tocarlo:
//   · SÓLO LEE. La estructura de la base sólo la cambian sus migraciones, y la copia tampoco escribe
//     filas.
//   · **Una foto de la base.** Se lee y se comprime de una pasada y sin esperas (`GzipPorTrozos`,
//     `volcadoSql.ts`): el SQL del objeto es síncrono y la central es un hilo, así que mientras tanto
//     no se intercala ninguna escritura, y la copia no puede tener una licencia sin su negocio ni un
//     dispositivo sin el suyo. Sólo la subida, que ya es de lo leído, espera a la red. Lo que se paga
//     es que, mientras lee y comprime, la central no atiende a nadie: las llamadas esperan su turno.
//   · El techo va en la copia ENTERA, no en cada tabla (la regla de REV-21), y es de lo comprimido:
//     sin comprimir sólo se guarda el trozo que se está llenando. La copia se monta en memoria antes
//     de subirla, y al cerrarla ocupa dos veces lo comprimido; un objeto tiene 128 MB, y de eso vive
//     también la central. Pasado `TOPE_COMPRIMIDO` falla en voz alta —y el latido de la copia deja de
//     sonar— en vez de reventar el objeto. Hoy la base ocupa una fracción mínima de eso; el día que
//     se acerque, esto pasa a subir por partes (multipart de R2).
//   · El formato es el de la copia de los negocios (`volcadoSql.ts`): la línea de las migraciones,
//     el esquema, una sentencia de datos por línea y la línea del fin. Va todo lo que es de la base, y
//     una tabla que se cree mañana, sin tocar esto: callarse una tabla nueva es justo el fallo que una
//     copia no puede tener. Se quedan fuera las tablas de SQLite, las del propio objeto (`_cf_*`) y
//     `_migrations`, cuyo papel lo hace la línea de las migraciones (`esTablaDeLaCopia`). Se abre sin
//     nuestro código: `gunzip -c <copia>.sql.gz | sqlite3 central.db`.
//   · El bucket es PRIVADO y propio. Nunca `tpv-images`, que se sirve sin firma: esto lleva los
//     correos de los clientes, y las DEK de los negocios (cifradas con `LICENSE_STORE_KEY`,
//     que por eso tiene que estar guardada fuera de Cloudflare: sin ella la copia no los devuelve).
//   · Cuánto se guardan las copias lo decide la regla de ciclo de vida del bucket, no este código.
//     Tiene que ser menor que los 90 días de `RETENCION_ENVIOS_MS` (`server/purga.ts`), o los correos
//     que la purga promete olvidar seguirían vivos dentro de las copias.

import { esFechaYmd } from "../lib/fechas";
import { empezarVolcado, GzipPorTrozos, terminarVolcado, volcarFilas } from "./volcadoSql";

/** El techo de la copia comprimida, en bytes. Ver la cabecera. */
export const TOPE_COMPRIMIDO = 32 * 1024 * 1024;

/** Dónde caen las copias dentro del bucket. */
export const PREFIJO_COPIAS = "base-central/";

/** Lo que se le pasa a `BaseCentral.copiar` en vez de un día: una copia ahora, que no pisa la del día. */
export const COPIA_A_MANO = "a-mano";

/** Tablas que no son de la base: las internas de SQLite y las del SQLite de un Durable Object. */
const AJENAS = /^(sqlite_|_cf_)/i;

/** ¿Va esta tabla en la copia (y puede traerla una copia al restaurar)? Todas las de la base menos `_migrations`. */
export function esTablaDeLaCopia(tabla: string): boolean {
	return !AJENAS.test(tabla) && tabla !== "_migrations";
}

/** La copia del día `dia` (AAAA-MM-DD), la del cron. Repetirla el mismo día la reescribe. */
export function claveDelDia(dia: string): string {
	if (!esFechaYmd(dia)) throw new RangeError(`La copia de la base central es de un día (AAAA-MM-DD), no de «${dia}».`);
	return `${PREFIJO_COPIAS}${dia}.sql.gz`;
}

/**
 * Una copia con la hora en el nombre: la de a mano (`a-mano`) o la de antes de volver a un instante
 * (`antes-de-volver`). La hora va en ISO con guiones en vez de dos puntos, para que la clave sirva
 * de nombre de fichero también en Windows al bajarla.
 */
export function claveConHora(que: "a-mano" | "antes-de-volver", ahora: Date): string {
	return `${PREFIJO_COPIAS}${que}-${ahora.toISOString().replaceAll(":", "-")}.sql.gz`;
}

/** ¿Puede ser `clave` la de una copia de la central? Dentro de su carpeta, de un `.sql.gz` y sin `..`. */
export function esClaveDeCopiaDeLaCentral(clave: string): boolean {
	return (
		clave.startsWith(PREFIJO_COPIAS) &&
		clave.endsWith(".sql.gz") &&
		clave.length > PREFIJO_COPIAS.length + ".sql.gz".length &&
		!clave.includes("..")
	);
}

export type CopiaHecha = {
	clave: string;
	tablas: number;
	filas: number;
	bytes: number;
};

type Volcado = { gzip: Uint8Array; tablas: number; filas: number; migraciones: string[] };

/**
 * Copia la base central entera a `bucket`, con la clave `clave`, y devuelve qué se subió. Lanza si
 * algo falla. `tope` sólo lo cambian los tests.
 */
export async function copiarLaCentral(
	sql: SqlStorage,
	bucket: R2Bucket,
	clave: string,
	tope: number = TOPE_COMPRIMIDO,
): Promise<CopiaHecha> {
	const ahora = new Date();
	// La foto, entera, comprimida y sin esperas. Lo que viene después ya no la toca.
	const volcado = volcarLaCentral(sql, { ahora, tope });

	await bucket.put(clave, volcado.gzip, {
		httpMetadata: { contentType: "application/gzip" },
		customMetadata: {
			generada: ahora.toISOString(),
			tablas: String(volcado.tablas),
			filas: String(volcado.filas),
			ultimaMigracion: volcado.migraciones.at(-1) ?? "",
		},
		// R2 recalcula el hash al recibirlo y rechaza la subida si no coincide.
		sha256: await crypto.subtle.digest("SHA-256", volcado.gzip),
	});

	return { clave, tablas: volcado.tablas, filas: volcado.filas, bytes: volcado.gzip.byteLength };
}

/** Lee la base central entera y la deja comprimida en memoria. Síncrona a propósito: es lo que la hace una foto. */
export function volcarLaCentral(sql: SqlStorage, opciones: { ahora: Date; tope?: number }): Volcado {
	const gz = new GzipPorTrozos(opciones.tope ?? TOPE_COMPRIMIDO);
	const migraciones = sql
		.exec("SELECT name FROM _migrations ORDER BY rowid;")
		.toArray()
		.map((f) => String(f.name));

	empezarVolcado(gz, {
		titulo: "Copia de la base central de tpv-api (control-plane). PROD-02.",
		ahora: opciones.ahora,
		migraciones,
		notas: [
			"Sin _migrations: al devolverla a su objeto, el esquema lo ponen las migraciones del worker.",
			"Abrir en local: gunzip -c <este fichero> | sqlite3 central.db",
			"Devolverla a un objeto vacío: pnpm central:aprovisionar -- --copia <clave> --si",
		],
	});

	const objetos = sql
		.exec(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid;`)
		.toArray()
		.map((r) => ({
			tipo: String(r.type),
			nombre: String(r.name),
			tabla: String(r.tbl_name),
			sql: String(r.sql),
		}))
		.filter((o) => !AJENAS.test(o.nombre) && esTablaDeLaCopia(o.tabla));

	let tablas = 0;
	let filas = 0;
	// Primero cada tabla con sus filas; los índices, vistas y triggers al final, como hace
	// `sqlite3 .dump`: crear un índice sobre la tabla llena es más rápido que mantenerlo fila a
	// fila, y un trigger creado antes de los INSERT se dispararía al abrirla.
	for (const t of objetos.filter((o) => o.tipo === "table")) {
		gz.linea(`${t.sql};`);
		tablas++;
		filas += volcarFilas(sql, t.nombre, gz, { porRowid: true });
	}
	for (const o of objetos.filter((o) => o.tipo !== "table")) {
		gz.linea(`${o.sql};`);
	}

	terminarVolcado(gz, { filas, tablas });
	return { gzip: gz.cerrar().gzip, tablas, filas, migraciones };
}

/** Una copia de la central en R2, con lo que dicen sus metadatos. */
export type CopiaGuardadaDeLaCentral = {
	clave: string;
	bytes: number;
	/** Cuándo llegó a R2 (ISO). */
	subida: string;
	/** Cuándo se leyó la base (ISO), si lo dice. */
	generada: string | null;
	filas: number | null;
	tablas: number | null;
	/** La última migración del esquema con el que se hizo: si este worker la sabe poner, se puede restaurar. */
	ultimaMigracion: string | null;
};

/** Las copias de la central, de la más reciente a la más vieja: las `techo` primeras, y si hay más. */
export async function listarCopiasDeLaCentral(
	bucket: R2Bucket,
	techo: number,
): Promise<{ copias: CopiaGuardadaDeLaCentral[]; hayMas: boolean }> {
	const todas: (CopiaGuardadaDeLaCentral & { subidaMs: number })[] = [];
	const numero = (v: string | undefined) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : null);
	let cursor: string | undefined;
	do {
		const pagina = await bucket.list({ prefix: PREFIJO_COPIAS, cursor, limit: 1000, include: ["customMetadata"] });
		for (const o of pagina.objects) {
			const meta = o.customMetadata ?? {};
			todas.push({
				clave: o.key,
				bytes: o.size,
				subida: o.uploaded.toISOString(),
				subidaMs: o.uploaded.getTime(),
				generada: meta.generada ?? null,
				filas: numero(meta.filas),
				tablas: numero(meta.tablas),
				ultimaMigracion: meta.ultimaMigracion || null,
			});
		}
		cursor = pagina.truncated ? pagina.cursor : undefined;
	} while (cursor);
	// Las claves no se ordenan por fecha (las del día, las de a mano…): manda cuándo llegó cada una.
	todas.sort((a, b) => b.subidaMs - a.subidaMs || (a.clave < b.clave ? 1 : -1));
	return { copias: todas.slice(0, techo).map(({ subidaMs: _, ...c }) => c), hayMas: todas.length > techo };
}
