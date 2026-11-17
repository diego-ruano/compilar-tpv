// src/durableObjects/tenantHub.tiempo.ts
//
// Determinismo del tiempo en las escrituras replicadas (SYNC-04, CFG-04).
//
// Es la pieza que garantiza que una misma escritura produzca **la misma fila** en la nube, en
// la Main y en la Handy. El reloj lo pone el dispositivo emisor vía la cabecera
// `X-Client-Now`, NO el servidor: una sentencia que viajara con `datetime('now')` se
// reevaluaría aquí (UTC) y otra vez en cada re-apply, divergiendo entre los tres.
//
// Por eso la hora actual se resuelve a un literal fijo **antes** de ejecutar y de registrarlo en
// `Sync_Changes`. Si el cliente no mandó hora, se fija una del servidor una sola vez (sigue siendo
// determinista, sólo que en UTC).
//
// Lo que se sabe fijar es `'now','localtime'`, con o sin modificadores detrás, porque `X-Client-Now`
// es la hora LOCAL del emisor. Un `'now'` en UTC o un `CURRENT_*` no tienen con qué resolverse, y un
// `'localtime'` aplicado a un valor depende de la zona de quien lo ejecuta: esos no se dejan pasar
// (`horaSinFijar`), porque la alternativa es que la base ponga su propia hora (CFG-04).
//
// Un fallo aquí no revienta nada: corrompe la replicación en silencio, que es la peor forma
// de fallar que tiene este sistema. De ahí que viva aparte y tenga sus propios tests.
//
// REV-03: `parseClientNow` y `rewriteNowInSql` los usa también el camino de LECTURA
// (`lib/tenantClient.ts`), por el mismo motivo y con el mismo criterio: un `'now','localtime'` que
// resuelva la base es el día del servidor, no el del bar. Son las dos mitades de una sola regla, así
// que viven en un solo sitio; si cambias cómo se fija la hora, cambias las dos a la vez.

import { diaDeInstante } from "../lib/fechas";
import { recortar } from "../lib/texto";
import type { InternalApplyCommand } from "./tenantHub.types";

const CLIENT_NOW_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/**
 * El reloj de pared del DO. Vive aquí, con el resto del tiempo, porque lo usan varios módulos del
 * hub y dos definiciones del mismo `Date.now()` son dos sitios donde algún día alguien mockeará
 * uno y no el otro.
 */
export function nowMs(): number {
	return Date.now();
}

export function serverNowFixed(): string {
	return new Date().toISOString().slice(0, 19).replace("T", " ");
}

// Margen máximo: offset de zona horaria (±14 h) + 5 min de deriva de reloj.
// Esto bloquea inyecciones de fechas arbitrarias (pasadas/futuras) sin romper
// ningún timezone legítimo. El valor se trata como naive-UTC para la comparación.
const MAX_CLIENT_NOW_DRIFT_MS = (14 * 60 + 5) * 60 * 1000;

// Devuelve el literal `YYYY-MM-DD HH:MM:SS` SOLO si el emisor mandó una hora válida y dentro de la
// deriva admisible; `null` si falta o es inaceptable (formato/deriva). NO cae a UTC en silencio: esa
// decisión la toma el llamador (ver el guard `missing_client_now` en applyInternalCommandIdempotent).
//
// AUD-21: la forma no basta. Con un componente imposible (las 24:30, el mes 13, el minuto 60)
// `getTime()` da `NaN`, la comparación de la deriva da falso y la cadena valía como «ahora»; y un
// 29 de febrero de un año que no es bisiesto se desborda al 1 de marzo y pasaba por cerca. Tiene que
// ser un instante del calendario (`diaDeInstante`, el criterio del resto del worker y de
// `tpv_domain::fechas`) y su instante, un número. Si no, se trata como una forma mala.
export function parseClientNow(raw: unknown): string | null {
	const s = String(raw ?? "").trim();
	if (!CLIENT_NOW_RE.test(s) || diaDeInstante(s) === null) return null;
	const clientMs = new Date(s.replace(" ", "T") + "Z").getTime();
	if (!Number.isFinite(clientMs) || Math.abs(Date.now() - clientMs) > MAX_CLIENT_NOW_DRIFT_MS) return null;
	return s;
}

const CLIENT_NOW_CON_DESFASE_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})([+-]\d{2}:\d{2})$/;

/**
 * MES-INC-03: el instante de una `X-Client-Now` que lleva su desfase (`YYYY-MM-DD HH:MM:SS+HH:MM`,
 * la de la Handy); `null` si no lo lleva o no es un instante. La hora de pared de la Handy es la de
 * SU zona, que puede no ser la del negocio (un Android en GMT en un bar de Madrid): con el desfase,
 * el TenantHub la pasa a la hora del negocio antes de ejecutar la ruta (`conLaHoraDelNegocio`), y
 * todo lo de abajo sigue leyendo una hora sin desfase. La de la Main va sin él: es la del negocio.
 */
export function instanteDeClientNow(raw: unknown): number | null {
	const m = CLIENT_NOW_CON_DESFASE_RE.exec(recortar(String(raw ?? "")));
	if (!m || diaDeInstante(`${m[1]} ${m[2]}`) === null) return null;
	const ms = Date.parse(`${m[1]}T${m[2]}${m[3]}`);
	return Number.isFinite(ms) ? ms : null;
}

// Las funciones de fecha de SQLite. Un `'now'` sólo es «ahora» cuando es argumento de una de ellas:
// fuera de ellas es un texto como otro cualquiera, y una nota que diga "now" no es una hora.
const FUNCIONES_DE_FECHA = new Set([
	"datetime",
	"date",
	"time",
	"julianday",
	"strftime",
	"unixepoch",
	"timediff",
]);

/** Un carácter que `\s` da por espacio. */
const ESPACIO = /\s/;

/** La letra en minúsculas, si es una mayúscula ASCII; si no, la misma. */
function enMinuscula(c: number): number {
	return c >= 65 && c <= 90 ? c + 32 : c;
}

/** `[a-z0-9_]`, sin mirar mayúsculas. */
function esDePalabra(c: number): boolean {
	const m = enMinuscula(c);
	return (m >= 97 && m <= 122) || (m >= 48 && m <= 57) || m === 95;
}

function esCifra(c: number): boolean {
	return c >= 48 && c <= 57;
}

/**
 * El nombre que lleva delante el paréntesis que está en `j`, en minúsculas, o `null`: la palabra que
 * lo precede, con espacios entre los dos o sin ellos, desde su primera letra o guion bajo
 * (`9datetime(` es `datetime`). Es lo que daba `/([a-z_][a-z0-9_]*)\s*$/` sobre todo lo anterior al
 * paréntesis, pero se miran sólo esos espacios y esa palabra: ninguno de los dos pasa de un
 * paréntesis, así que el tramo de uno no llega al del anterior y cada carácter del SQL se mira como
 * mucho una vez.
 */
function nombreAntesDe(sql: string, j: number): string | null {
	let fin = j;
	while (fin > 0 && ESPACIO.test(sql[fin - 1])) fin--;
	let inicio = fin;
	while (inicio > 0 && esDePalabra(sql.charCodeAt(inicio - 1))) inicio--;
	while (inicio < fin && esCifra(sql.charCodeAt(inicio))) inicio++;
	// Sólo letras ASCII, cifras y guion bajo: en minúsculas tiene la misma longitud.
	return inicio < fin ? sql.slice(inicio, fin).toLowerCase() : null;
}

/** ¿Empieza en `i` un `'now'`, en cualquier caja? */
function esAhora(sql: string, i: number): boolean {
	return (
		sql.charCodeAt(i) === 39 &&
		enMinuscula(sql.charCodeAt(i + 1)) === 110 &&
		enMinuscula(sql.charCodeAt(i + 2)) === 111 &&
		enMinuscula(sql.charCodeAt(i + 3)) === 119 &&
		sql.charCodeAt(i + 4) === 39
	);
}

/**
 * Dónde empieza, en `sql`, cada `'now'` que es argumento de una función de fecha.
 *
 * SYNC-34: una sola pasada hacia delante, con una pila de los paréntesis abiertos que dice de cada
 * uno si es el de una función de fecha; un `'now'` mira la cima. Antes cada `'now'` recorría hacia
 * atrás el texto hasta su paréntesis y pasaba una expresión sobre todo lo anterior: con muchos
 * `'now'`, o con una palabra muy larga delante, el cuadrado de la longitud del SQL. Reconoce lo
 * mismo (`test/tenantHubTiempo.test.ts` lo contrasta con aquel recorrido): la cima es el paréntesis
 * abierto más cercano que no se cierra antes del `'now'`, que es el que se encontraba hacia atrás, y
 * las comillas siguen sin contar. Las mayúsculas se miran carácter a carácter, sólo las ASCII y
 * sobre el texto tal cual: `toLowerCase()` alarga algún carácter (`İ` pasa a ser dos), y las
 * posiciones dejarían de ser las del texto en el que se sustituye.
 */
function ahorasDeFecha(sql: string): Set<number> {
	const posiciones = new Set<number>();
	const abiertos: boolean[] = [];
	for (let i = 0; i < sql.length; i++) {
		const c = sql.charCodeAt(i);
		if (c === 40) {
			const nombre = nombreAntesDe(sql, i);
			abiertos.push(nombre !== null && FUNCIONES_DE_FECHA.has(nombre));
		} else if (c === 41) {
			// Un `)` sin su `(` no cierra nada.
			abiertos.pop();
		} else if (c === 39 && abiertos[abiertos.length - 1] === true && esAhora(sql, i)) {
			posiciones.add(i);
		}
	}
	return posiciones;
}

// ¿Alguna sentencia del comando pide la hora actual SIN resolver? Si la hay, EXIGIMOS X-Client-Now
// para fijarla a literal determinista; si no, el comando ya viene con literales (p. ej. desde la
// Main, que resuelve todas las suyas) y no hace falta.
export function sqlHasNowLiteral(sql: unknown): boolean {
	return typeof sql === "string" && ahorasDeFecha(sql).size > 0;
}

export function commandHasNowLiteral(cmd: InternalApplyCommand): boolean {
	switch (cmd.type) {
		case "tenantDb.exec":
		case "tenantDb.value":
		case "tenantDb.row":
		case "tenantDb.rows":
			return sqlHasNowLiteral(cmd.payload?.sql);
		case "tenantDb.transaction":
			return (cmd.payload?.steps ?? []).some((s: any) => sqlHasNowLiteral(s?.sql));
		default:
			return false;
	}
}

// `'now','localtime'`, con cualquier espaciado y en cualquier caja.
const AHORA_LOCAL_RE = /'now'\s*,\s*'localtime'/gi;

// Fija la hora local del emisor. Las dos formas canónicas quedan como literal suelto; el resto de
// `'now','localtime'` se sustituye por la hora y conserva sus modificadores detrás
// (`datetime('now','localtime','-2 days')` → `datetime('<dt>','-2 days')`), que dan el mismo valor.
// El literal está validado por `CLIENT_NOW_RE`, así que no hay inyección.
export function rewriteNowInSql(sql: string, dt: string): string {
	if (typeof sql !== "string" || !sqlHasNowLiteral(sql)) return sql;
	const d = dt.slice(0, 10);
	const conLasCanonicas = sql
		.split("datetime('now','localtime')").join(`'${dt}'`)
		.split("date('now','localtime')").join(`'${d}'`);
	// Una vez para todo el texto (SYNC-34), no una por cada `'now','localtime'`.
	const deFecha = ahorasDeFecha(conLasCanonicas);
	return conLasCanonicas.replace(AHORA_LOCAL_RE, (m: string, offset: number) =>
		deFecha.has(offset) ? `'${dt}'` : m,
	);
}

export function rewriteCmdNowLiterals(
	cmd: InternalApplyCommand,
	dt: string,
): InternalApplyCommand {
	switch (cmd.type) {
		case "tenantDb.exec":
		case "tenantDb.value":
		case "tenantDb.row":
		case "tenantDb.rows":
			return {
				type: cmd.type,
				payload: { ...cmd.payload, sql: rewriteNowInSql(cmd.payload.sql, dt) },
			} as InternalApplyCommand;
		case "tenantDb.transaction":
			return {
				type: cmd.type,
				payload: {
					...cmd.payload,
					steps: (cmd.payload.steps ?? []).map((s: any) => ({
						...s,
						sql: rewriteNowInSql(s.sql, dt),
					})),
				},
			} as InternalApplyCommand;
		default:
			return cmd;
	}
}

const CURRENT_RE = /(^|[^a-z0-9_])current_(timestamp|date|time)(?![a-z0-9_])/i;

// Tras reescribir: ¿queda en este SQL alguna hora que tendría que elegir la base que lo ejecute?
// Devuelve lo encontrado, o `null`.
export function horaSinFijarEnSql(sql: unknown): string | null {
	if (typeof sql !== "string") return null;
	if (sqlHasNowLiteral(sql)) return "'now'";
	if (CURRENT_RE.test(sql)) return "CURRENT_*";
	const minus = sql.toLowerCase();
	if (minus.includes("'localtime'")) return "'localtime'";
	if (minus.includes("'utc'")) return "'utc'";
	return null;
}

// CFG-04: lo mismo para un comando entero, y sólo en lo que ESCRIBE. Una lectura dentro del comando
// no viaja a ningún sitio, así que la hora que use no descuadra nada.
export function horaSinFijar(cmd: InternalApplyCommand): string | null {
	switch (cmd.type) {
		case "tenantDb.exec":
			return horaSinFijarEnSql(cmd.payload?.sql);
		case "tenantDb.transaction":
			for (const s of (cmd.payload?.steps ?? []) as any[]) {
				if (s?.kind !== "execute") continue;
				const encontrada = horaSinFijarEnSql(s?.sql);
				if (encontrada) return encontrada;
			}
			return null;
		default:
			return null;
	}
}
