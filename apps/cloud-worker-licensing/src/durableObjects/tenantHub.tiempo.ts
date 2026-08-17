// src/durableObjects/tenantHub.tiempo.ts
//
// Determinismo del tiempo en las escrituras replicadas (SYNC-04).
//
// Es la pieza que garantiza que una misma escritura produzca **la misma fila** en la nube, en
// la Main y en la Handy. El reloj lo pone el dispositivo emisor vía la cabecera
// `X-Client-Now`, NO el servidor: una sentencia que viajara con `datetime('now')` se
// reevaluaría aquí (UTC) y otra vez en cada re-apply, divergiendo entre los tres.
//
// Por eso el `datetime('now','localtime')` se resuelve a un literal fijo **antes** de
// ejecutar y de registrarlo en `Sync_Changes`. Si el cliente no mandó hora, se fija una del
// servidor una sola vez (sigue siendo determinista, sólo que en UTC).
//
// Un fallo aquí no revienta nada: corrompe la replicación en silencio, que es la peor forma
// de fallar que tiene este sistema. De ahí que viva aparte y tenga sus propios tests.

import type { InternalApplyCommand } from "./tenantHub.types";

const CLIENT_NOW_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

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

// ¿Alguna sentencia del comando lleva una forma `datetime('now',...)`/`date('now',...)` SIN resolver?
// (misma señal `('now'` que usa `rewriteNowInSql`.) Si la hay, EXIGIMOS X-Client-Now para fijarla a
// literal determinista; si no, el comando ya viene con literales (p. ej. desde la Main) y no hace falta.
export function sqlHasNowLiteral(sql: unknown): boolean {
	return typeof sql === "string" && sql.includes("('now'");
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

// Reemplaza SOLO las formas exactas (no las que llevan modificador, que acaban en
// `,'…')`). El literal está validado por `CLIENT_NOW_RE`, así que no hay inyección.
export function rewriteNowInSql(sql: string, dt: string): string {
	if (typeof sql !== "string" || !sql.includes("('now'")) return sql;
	const d = dt.slice(0, 10);
	return sql
		.split("datetime('now','localtime')").join(`'${dt}'`)
		.split("date('now','localtime')").join(`'${d}'`);
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
