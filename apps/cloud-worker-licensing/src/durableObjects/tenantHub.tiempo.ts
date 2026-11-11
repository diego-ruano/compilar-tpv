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
export function parseClientNow(raw: unknown): string | null {
	const s = String(raw ?? "").trim();
	if (!CLIENT_NOW_RE.test(s)) return null;
	const clientMs = new Date(s.replace(" ", "T") + "Z").getTime();
	if (Math.abs(Date.now() - clientMs) > MAX_CLIENT_NOW_DRIFT_MS) return null;
	return s;
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

// ¿El `'now'` que empieza en `i` es argumento de una función de fecha? Se busca hacia atrás el
// paréntesis que lo abre y el nombre que lleva delante. `minus` es el SQL en minúsculas.
function esArgumentoDeFecha(minus: string, i: number): boolean {
	let profundidad = 0;
	for (let j = i - 1; j >= 0; j--) {
		const c = minus[j];
		if (c === ")") {
			profundidad++;
		} else if (c === "(") {
			if (profundidad > 0) {
				profundidad--;
				continue;
			}
			const nombre = /([a-z_][a-z0-9_]*)\s*$/.exec(minus.slice(0, j));
			return nombre !== null && FUNCIONES_DE_FECHA.has(nombre[1]);
		}
	}
	return false;
}

// ¿Alguna sentencia del comando pide la hora actual SIN resolver? Si la hay, EXIGIMOS X-Client-Now
// para fijarla a literal determinista; si no, el comando ya viene con literales (p. ej. desde la
// Main, que resuelve todas las suyas) y no hace falta.
export function sqlHasNowLiteral(sql: unknown): boolean {
	if (typeof sql !== "string") return false;
	const minus = sql.toLowerCase();
	for (let i = minus.indexOf("'now'"); i !== -1; i = minus.indexOf("'now'", i + 1)) {
		if (esArgumentoDeFecha(minus, i)) return true;
	}
	return false;
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
	return sql
		.split("datetime('now','localtime')").join(`'${dt}'`)
		.split("date('now','localtime')").join(`'${d}'`)
		.replace(AHORA_LOCAL_RE, (m: string, offset: number, entero: string) =>
			esArgumentoDeFecha(entero.toLowerCase(), offset) ? `'${dt}'` : m,
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
