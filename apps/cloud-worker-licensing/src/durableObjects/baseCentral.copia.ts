// src/durableObjects/baseCentral.copia.ts
//
// PROD-02 · La copia diaria de la base central a R2. La hace el propio objeto (`BaseCentral.copiar`),
// y la pide el cron (`index.ts::programado`); no hay ninguna ruta que la dispare.
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
//   · Va todo lo que es de la base, también `_migrations`, que dice en qué versión de su esquema
//     está; y una tabla que se cree mañana, sin tocar esto: callarse una tabla nueva es justo el
//     fallo que una copia no puede tener. Sólo se quedan fuera las tablas de SQLite y las del propio
//     objeto (`_cf_*`).
//   · El formato es un volcado SQL comprimido con gzip, con una sentencia de datos por línea, para
//     abrirla sin nuestro código: `gunzip -c <copia>.sql.gz | sqlite3 central.db`.
//   · El bucket es PRIVADO y propio. Nunca `tpv-images`, que se sirve sin firma: esto lleva los
//     correos de los clientes, y las DEK de los negocios (cifradas con `LICENSE_STORE_KEY`,
//     que por eso tiene que estar guardada fuera de Cloudflare: sin ella la copia no los devuelve).
//   · Cuánto se guardan las copias lo decide la regla de ciclo de vida del bucket, no este código.
//     Tiene que ser menor que los 90 días de `RETENCION_ENVIOS_MS` (`server/purga.ts`), o los correos
//     que la purga promete olvidar seguirían vivos dentro de las copias.

import { esFechaYmd } from "../lib/fechas";
import { GzipPorTrozos, identificador, literalEnUnaLinea } from "./volcadoSql";

/** El techo de la copia comprimida, en bytes. Ver la cabecera. */
export const TOPE_COMPRIMIDO = 32 * 1024 * 1024;

/** Dónde caen las copias dentro del bucket. Una por día: repetirla el mismo día la reescribe. */
export const PREFIJO_COPIAS = "base-central/";

/** Tablas que no son de la base: las internas de SQLite y las del SQLite de un Durable Object. */
const AJENAS = /^(sqlite_|_cf_)/i;

export type CopiaHecha = {
	clave: string;
	tablas: number;
	filas: number;
	bytes: number;
};

/**
 * Copia la base central entera a `bucket`, como la copia del día `dia` (AAAA-MM-DD), y devuelve qué
 * se subió. Lanza si algo falla. `tope` sólo lo cambian los tests.
 */
export async function copiarLaCentral(
	sql: SqlStorage,
	bucket: R2Bucket,
	dia: string,
	tope: number = TOPE_COMPRIMIDO,
): Promise<CopiaHecha> {
	if (!esFechaYmd(dia)) throw new RangeError(`La copia de la base central es de un día (AAAA-MM-DD), no de «${dia}».`);
	const ahora = new Date();
	// La foto, entera, comprimida y sin esperas. Lo que viene después ya no la toca.
	const volcado = volcar(sql, ahora, tope);
	const clave = `${PREFIJO_COPIAS}${dia}.sql.gz`;

	await bucket.put(clave, volcado.gzip, {
		httpMetadata: { contentType: "application/gzip" },
		customMetadata: {
			generada: ahora.toISOString(),
			tablas: String(volcado.tablas),
			filas: String(volcado.filas),
		},
		// R2 recalcula el hash al recibirlo y rechaza la subida si no coincide.
		sha256: await crypto.subtle.digest("SHA-256", volcado.gzip),
	});

	return { clave, tablas: volcado.tablas, filas: volcado.filas, bytes: volcado.gzip.byteLength };
}

type Volcado = { gzip: Uint8Array; tablas: number; filas: number };

function volcar(sql: SqlStorage, ahora: Date, tope: number): Volcado {
	const gz = new GzipPorTrozos(tope);

	gz.linea("-- Copia de la base central de tpv-api (control-plane). PROD-02.");
	gz.linea(`-- Generada: ${ahora.toISOString()}`);
	gz.linea("-- Abrir en local: gunzip -c <este fichero> | sqlite3 central.db");
	gz.linea("PRAGMA foreign_keys=OFF;");
	gz.linea("BEGIN TRANSACTION;");

	const objetos = sql
		.exec(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL;`)
		.toArray()
		.map((r) => ({
			tipo: String(r.type),
			nombre: String(r.name),
			tabla: String(r.tbl_name),
			sql: String(r.sql),
		}))
		.filter((o) => !AJENAS.test(o.nombre) && !AJENAS.test(o.tabla));

	let tablas = 0;
	let filas = 0;
	// Primero cada tabla con sus filas; los índices, vistas y triggers al final, como hace
	// `sqlite3 .dump`: crear un índice sobre la tabla llena es más rápido que mantenerlo fila a
	// fila, y un trigger creado antes de los INSERT se dispararía al restaurar.
	for (const t of objetos.filter((o) => o.tipo === "table")) {
		gz.linea(`${t.sql};`);
		tablas++;
		filas += volcarFilas(sql, t.nombre, gz);
	}
	for (const o of objetos.filter((o) => o.tipo !== "table")) {
		gz.linea(`${o.sql};`);
	}

	gz.linea("COMMIT;");
	return { gzip: gz.cerrar().gzip, tablas, filas };
}

/** Las filas de `tabla`, en el orden en que se insertaron, como `INSERT` con sus columnas. */
function volcarFilas(sql: SqlStorage, tabla: string, gz: GzipPorTrozos): number {
	const nombre = identificador(tabla);
	const cursor = sql.exec(`SELECT * FROM ${nombre} ORDER BY rowid;`);
	const lista = cursor.columnNames.map(identificador).join(", ");
	let total = 0;
	for (const valores of cursor.raw()) {
		gz.linea(`INSERT INTO ${nombre} (${lista}) VALUES (${valores.map(literalEnUnaLinea).join(", ")});`);
		total++;
	}
	return total;
}
