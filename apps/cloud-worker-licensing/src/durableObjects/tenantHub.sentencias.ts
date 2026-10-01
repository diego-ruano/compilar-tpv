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
// caso típico: un `nuevoId()` guardado con `saveAs` y referenciado por el INSERT
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
//
// ⚠️ **Esto NO es un `includes` pendiente de arreglar: es el precio del diseño** (ARQ-07). Se
// escribe porque la forma de romperlo es que a alguien le parezca obvio darle un código propio.
//
//   · **El gate no lleva `ON CONFLICT` a propósito.** Que la violación reviente es lo que hace el
//     `ROLLBACK` del batch entero, y en una sola operación atómica. Sacándolo fuera del batch con
//     `ON CONFLICT(Op_Id) DO NOTHING` + `rowsAffected`, un batch que fallara DESPUÉS dejaría la fila
//     del gate puesta: el siguiente reintento recibiría «ya aplicada» y la operación se perdería
//     para siempre. Eso es peor que lo que arreglaría.
//   · **El texto lo pone SQLite, no libsql.** La regla de §9 («los mensajes de libsql cambian de
//     redacción entre versiones») apunta a la capa de transporte, no a esta constante del motor.
//   · **Un falso NEGATIVO no corrompe**: convierte un reintento idempotente en una operación
//     apartada, que es ruidosa (cuarentena + Sentry). El falso POSITIVO sí sería grave --dar por
//     aplicada una operación que no lo está-- y por eso lo único que hay que vigilar es que ninguna
//     tabla de NEGOCIO pueda producir esta misma señal: lo hace `test/opIdSchemaGuard.test.ts`,
//     que recorre el esquema y falla si aparece un UNIQUE sobre una columna llamada `Op_Id`.
export function isUniqueOpIdViolation(e: any): boolean {
	const m = String(e?.message ?? e ?? "").toLowerCase();
	return m.includes("unique constraint failed") && m.includes("op_id");
}
