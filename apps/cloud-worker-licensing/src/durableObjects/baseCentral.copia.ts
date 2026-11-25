// src/durableObjects/baseCentral.copia.ts
//
// PROD-02 · Las copias de la base central a R2. Las hace el propio objeto (`BaseCentral.copiar`): la
// del día la pide el cron (`index.ts::programado`), una «a mano» la administración
// (`/v1/admin/central/copiar-ahora`), y la de antes de volver a un instante, la propia vuelta
// (`baseCentral.instante.ts`). Se devuelven a un objeto vacío con `baseCentral.restaurar.ts`.
//
// La de antes de volver lleva además en sus metadatos el marcador de la central cuando se hizo
// (`marcador`), que es con el que se deshace la vuelta: fuera del objeto, porque lo que guarda el
// objeto vuelve con él. Si la central no se podía copiar, ese marcador va solo, en
// `base-central/antes-de-volver-<hora>.marcador`, que no es una copia y no se restaura. Los dos salen
// en la lista de las copias. Y cuando la plataforma ya tiene la vuelta, se deja constancia al lado,
// en `base-central/antes-de-volver-<hora>.pedida`: sin ella, una vuelta pedida y una que no llegó a
// pedirse se ven igual desde fuera (la central atiende en los dos casos). Va en la fila de su copia
// de antes, o de su `.marcador`, como `pedida`.
//
// La base vive en el SQLite de su objeto, y Cloudflare la puede devolver a cualquier instante de los
// últimos 30 días. Eso no cubre que el objeto se pierda (un borrado por error, otro nombre, el propio
// proveedor), ni lo que se descubre pasado ese plazo: para eso está esta copia, fuera del objeto.
//
// Y por qué importa tanto esta base en concreto: sin `licenses` y `devices`, el worker contesta
// `license_not_found` a todos los equipos. El TPV no borra su licencia por eso (RI-09): un rechazo
// sin firmar es `FalloConsulta::RechazoSinFirmar` (`tpv-infra-licensing::clasificar_error`), que
// `tpv_domain::licensing::evaluar_fallo` trata como no haber podido comprobar (`rejection_unverified`):
// sigue vendiendo mientras dure la gracia sin conexión y, agotada, se bloquea. La Handy, que trabaja
// contra la nube, se queda sin poder hacer nada («No hay una licencia activa»), y el alta, el
// emparejamiento y la reserva web fallan como si fuera de verdad. Perder esta base no es perder un
// histórico: es parar todos los negocios.
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
//   · Cuánto se guardan las copias lo decide la regla de ciclo de vida del bucket, no este código:
//     `caducar-copias`, 30 días para todo `base-central/` (también los `.marcador` y los `.pedida`;
//     `wrangler r2 bucket lifecycle list tpv-copias-control`). Tiene que ser menor que los 90 días de
//     `RETENCION_ENVIOS_MS` (`server/purga.ts`), o los correos que la purga promete olvidar seguirían
//     vivos dentro de las copias, y no menos que los 30 en que se puede deshacer una vuelta.

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
export function claveConHora(que: "a-mano" | "antes-de-volver", ahora: Date, extension = ".sql.gz"): string {
	return `${PREFIJO_COPIAS}${que}-${ahora.toISOString().replaceAll(":", "-")}${extension}`;
}

/**
 * Guarda en R2 el marcador de cómo estaba la central antes de volver a un instante, cuando no se
 * podía copiar (ver la cabecera). Lanza si no llega.
 */
export async function guardarElMarcadorDeAntes(bucket: R2Bucket, ahora: Date, marcador: string): Promise<string> {
	const clave = claveConHora("antes-de-volver", ahora, ".marcador");
	await bucket.put(clave, `${marcador}\n`, {
		httpMetadata: { contentType: "text/plain; charset=utf-8" },
		customMetadata: { generada: ahora.toISOString(), marcador },
	});
	return clave;
}

/** La constancia de que una vuelta se pidió (`guardarQueSePidio`): no es una copia, y va en la fila de la suya. */
const EXTENSION_PEDIDA = ".pedida";

/** Lo que comparten las claves de una misma vuelta: la copia de antes, su `.marcador` y su `.pedida`. */
const deLaMismaVuelta = (clave: string) => clave.replace(/\.(?:sql\.gz|marcador|pedida)$/, "");

/**
 * Deja en R2 que la vuelta preparada en `ahora` ya se le ha pedido a la plataforma, al lado de su
 * copia de antes o de su `.marcador` (ver la cabecera), con su marcador de deshacer. Lanza si no llega.
 */
export async function guardarQueSePidio(bucket: R2Bucket, ahora: Date, marcador: string): Promise<string> {
	const clave = claveConHora("antes-de-volver", ahora, EXTENSION_PEDIDA);
	await bucket.put(clave, `${marcador}\n`, {
		httpMetadata: { contentType: "text/plain; charset=utf-8" },
		customMetadata: { generada: ahora.toISOString(), marcador, pedida: new Date().toISOString() },
	});
	return clave;
}

/** Lo más largo que puede ser el nombre de una copia, entre la carpeta y `.sql.gz`. */
const TOPE_DEL_NOMBRE = 100;

/** Las letras del nombre de una copia: sin acentos, sin espacios, sin `/` ni `@`. */
const LETRAS_DEL_NOMBRE = /^[A-Za-z0-9._-]+$/;

/**
 * ¿Puede ser `clave` la de una copia de la central? Una gramática cerrada: la carpeta, un nombre de
 * hasta `TOPE_DEL_NOMBRE` letras de `[A-Za-z0-9._-]` sin `..`, y `.sql.gz`. Caben todas las que
 * escribe el worker (la del día, `a-mano-…` y `antes-de-volver-…`) y la del traspaso desde Turso
 * (`traspaso-turso-AAAA-MM-DD`); un texto libre, no. La clave va al rastro de la administración
 * (Axiom y el log), donde no puede llegar ni un nombre ni un correo.
 */
export function esClaveDeCopiaDeLaCentral(clave: string): boolean {
	if (!clave.startsWith(PREFIJO_COPIAS) || !clave.endsWith(".sql.gz")) return false;
	const nombre = clave.slice(PREFIJO_COPIAS.length, -".sql.gz".length);
	return nombre.length <= TOPE_DEL_NOMBRE && LETRAS_DEL_NOMBRE.test(nombre) && !clave.includes("..");
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
 * algo falla. `tope` sólo lo cambian los tests. `marcador`, el de la central al hacerla, va en sus
 * metadatos (la de antes de volver a un instante: ver la cabecera).
 */
export async function copiarLaCentral(
	sql: SqlStorage,
	bucket: R2Bucket,
	clave: string,
	tope: number = TOPE_COMPRIMIDO,
	marcador?: string,
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
			...(marcador ? { marcador } : {}),
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
	/**
	 * El marcador de la central cuando se hizo, si lo lleva (la de antes de volver a un instante, y el
	 * `….marcador` que va solo cuando no se podía copiar): volver a él deshace aquella vuelta.
	 */
	marcador: string | null;
	/**
	 * De antes de volver a un instante: cuándo se le pidió aquella vuelta a la plataforma (ISO), si
	 * consta (`….pedida`). Si no consta, no llegó a pedirse, salvo que el objeto se reiniciara justo
	 * entre pedirla y apuntarlo.
	 */
	pedida: string | null;
};

/**
 * Las copias de la central, de la más reciente a la más vieja: las `techo` primeras, y si hay más.
 * También los marcadores de antes de volver que van solos (`….marcador`), que no se restauran. La
 * constancia de que una vuelta se pidió (`….pedida`) no es una fila: va en la de su copia de antes o
 * de su `.marcador`, y sólo si no está ninguna de las dos, sola.
 */
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
				marcador: meta.marcador || null,
				pedida: meta.pedida || null,
			});
		}
		cursor = pagina.truncated ? pagina.cursor : undefined;
	} while (cursor);
	const esPedida = (c: { clave: string }) => c.clave.endsWith(EXTENSION_PEDIDA);
	const pedidas = new Map(todas.filter(esPedida).map((c) => [deLaMismaVuelta(c.clave), c.pedida]));
	const conFila = new Set(todas.filter((c) => !esPedida(c)).map((c) => deLaMismaVuelta(c.clave)));
	const filas = todas
		.filter((c) => !esPedida(c) || !conFila.has(deLaMismaVuelta(c.clave)))
		.map((c) => (esPedida(c) ? c : { ...c, pedida: pedidas.get(deLaMismaVuelta(c.clave)) ?? null }));
	// Las claves no se ordenan por fecha (las del día, las de a mano…): manda cuándo llegó cada una.
	filas.sort((a, b) => b.subidaMs - a.subidaMs || (a.clave < b.clave ? 1 : -1));
	return { copias: filas.slice(0, techo).map(({ subidaMs: _, ...c }) => c), hayMas: filas.length > techo };
}
