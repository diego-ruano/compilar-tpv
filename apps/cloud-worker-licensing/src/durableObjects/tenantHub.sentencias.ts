// src/durableObjects/tenantHub.sentencias.ts
//
// OJO CON EL NOMBRE: este fichero se llamaba `tenantHub.sql.ts` y el deploy fallaba. `wrangler.json`
// declara una regla `{ type: "Text", globs: ["**/*.sql"] }` --necesaria para que
// `tenantMigrations.ts` importe los .sql de migraciones-- y el import sin extension
// (`from "./tenantHub.sql"`) casaba ese glob: el bundler lo empaquetaba como modulo de TEXTO, que
// solo expone `default`, y el worker reventaba al arrancar con "does not provide an export named
// DDL_TABLAS_DE_NUBE". No se veia en `tsc` ni en vitest, que resuelven el .ts. No le pongas `.sql`
// al nombre de un modulo TypeScript.
//
// Manejo de las sentencias replicables dentro del DO: resolver los `$ref` de una transacción,
// normalizar valores que vienen de libsql y leer resultados.
//
// El mecanismo de `$ref` es lo que permite que un paso use el resultado de otro anterior (el
// caso típico: un `crypto.randomUUID()` guardado con `saveAs` y referenciado por el INSERT
// siguiente) manteniendo la sentencia **determinista**: la nube y la Main acaban con la misma
// fila porque el id se resuelve una vez y viaja resuelto.

import { bytesToB64 } from "../server/utils/base64";
import type { SqlArg, SqlRef, SqlScalar } from "./tenantHub.types";

export function isSqlRef(v: any): v is SqlRef {
	return !!v && typeof v === "object" && typeof v.$ref === "string";
}

export function normalizeSql(sql: any): string {
	const out = String(sql || "").trim();
	if (!out) throw new Error("missing_sql");
	return out;
}

export function toPlainValue(v: any): any {
	if (v == null) return null;
	if (typeof v === "bigint") return Number(v);
	if (v instanceof Uint8Array) return bytesToB64(v);
	if (Array.isArray(v)) return v.map(toPlainValue);
	if (typeof v === "object") {
		const out: Record<string, any> = {};
		for (const [k, val] of Object.entries(v)) out[k] = toPlainValue(val);
		return out;
	}
	return v;
}

export function resolveSqlArg(v: SqlArg, bag: Record<string, any>): SqlScalar {
	if (isSqlRef(v)) {
		const refVal = bag[v.$ref];
		if (refVal === undefined) throw new Error(`missing_ref:${v.$ref}`);

		if (
			refVal === null ||
			typeof refVal === "string" ||
			typeof refVal === "number" ||
			typeof refVal === "boolean"
		) {
			return refVal;
		}

		throw new Error(`bad_ref_value:${v.$ref}`);
	}

	if (
		v === null ||
		typeof v === "string" ||
		typeof v === "number" ||
		typeof v === "boolean"
	) {
		return v;
	}

	throw new Error("unsupported_sql_arg");
}

export function resolveSqlArgs(raw: any, bag: Record<string, any>): SqlScalar[] {
	if (raw == null) return [];
	if (!Array.isArray(raw)) throw new Error("invalid_sql_args");
	return raw.map((v) => resolveSqlArg(v as SqlArg, bag));
}

export function firstRowFromResult(result: any): any {
	const rows = result?.rows || [];
	if (!Array.isArray(rows) || rows.length === 0) return null;
	return toPlainValue(rows[0]);
}

export function allRowsFromResult(result: any): any[] {
	const rows = result?.rows || [];
	if (!Array.isArray(rows)) return [];
	return rows.map((r: any) => toPlainValue(r));
}

// Evalúa en JS un paso `value` para no gastar un round trip a Turso por cada uno.
// Cubre el set CERRADO de formas que generan los *.commands.ts (echo de un literal,
// constante numérica, o concatenación 'prefijo' || ?N). Cualquier otra forma lanza,
// para no resolver mal en silencio (fail-fast: lo detectarían los tests).
export function evalValueStep(sql: string, args: SqlScalar[]): SqlScalar {
	const s = String(sql || "").trim().replace(/;+\s*$/, "").trim();
	let m = s.match(/^SELECT\s+\?(\d+)$/i);
	if (m) return args[Number(m[1]) - 1] ?? null;
	m = s.match(/^SELECT\s+(-?\d+(?:\.\d+)?)$/i);
	if (m) return Number(m[1]);
	m = s.match(/^SELECT\s+'([^']*)'\s*\|\|\s*\?(\d+)$/i);
	if (m) return m[1] + String(args[Number(m[2]) - 1] ?? "");
	throw new Error(`value_step_no_evaluable_en_batch: ${sql}`);
}

// ¿El error de un batch es una violación de UNIQUE(Op_Id) en Applied_Operations?
// Es la señal de que la op ya estaba aplicada (reintento idempotente): el gate sin
// ON CONFLICT viola la constraint y hace rollback de TODO el batch automáticamente.
export function isUniqueOpIdViolation(e: any): boolean {
	const m = String(e?.message ?? e ?? "").toLowerCase();
	return m.includes("unique constraint failed") && m.includes("op_id");
}
