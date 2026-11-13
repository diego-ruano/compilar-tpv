// src/durableObjects/tenantHub.lote.ts
//
// ARQ-04 · De un comando a un lote de sentencias.
//
// El escalón que hay entre `tenantHub.sentencias.ts` (las primitivas: resolver un `$ref`,
// normalizar un valor de libsql, leer una fila de un resultado) y el motor de aplicación del
// TenantHub: coge un `InternalApplyCommand` y lo aplana a las piezas del batch atómico que se
// ejecuta contra la base del negocio.
//
// Vive fuera de la clase porque no toca NADA del Durable Object: ni `state`, ni la conexión al
// tenant, ni el censo de sockets. Es una función del comando a sus sentencias, y por eso se puede
// probar sin levantar un DO.

import { stableStringify, stringifyJsonValue } from "./tenantHub.envelope";
import type { InternalApplyCommand, ResolvedStmt, SqlScalar } from "./tenantHub.types";
import {
	allRowsFromResult,
	evalValueStep,
	firstRowFromResult,
	normalizeSql,
	resolveSqlArgs,
} from "./tenantHub.sentencias";

// Aplana un InternalApplyCommand a las piezas del batch atómico:
//  - middle:     sentencias a EJECUTAR en orden (execute + lecturas row/rows).
//  - replicated: solo las escrituras (execute), con args ya literales, que se capturan para
//                que la Main las aplique a su SQLite local (formato idéntico al de hoy).
//  - resolveResult(batchResults, offset): el resultado real tras ejecutar (lee rowsAffected /
//                filas del array de resultados del batch).
//  - storageResult: best-effort en build-time (literales sí; lo derivado de la DB → null)
//                para el Result_Json cacheado, que solo se devuelve en el reintento idempotente
//                (path que únicamente alcanza la Main por reenvío WS, y solo usa el `seq`).
//
// Los `value` (SELECT ?1 / constante / 'pref' || ?N) se evalúan en JS (sin round trip). Los IDs
// son UUID de JS y `now()` ya se resolvió a literal, así que ningún paso necesita leer la DB
// para alimentar un write posterior (las lecturas row/rows son solo de retorno).
export function buildApplyBatch(cmd: InternalApplyCommand): {
	middle: ResolvedStmt[];
	replicated: ResolvedStmt[];
	resolveResult: (batchResults: any[], offset: number) => any;
	storageResult: any;
} {
	if (cmd.type === "tenantDb.exec") {
		const stmt: ResolvedStmt = {
			sql: normalizeSql(cmd.payload.sql),
			args: resolveSqlArgs(cmd.payload.args, {}),
		};
		return {
			middle: [stmt],
			replicated: [stmt],
			resolveResult: (res, off) => Number(res?.[off]?.rowsAffected ?? 0),
			storageResult: null,
		};
	}

	if (cmd.type === "tenantDb.transaction") {
		const steps = Array.isArray(cmd.payload.steps) ? cmd.payload.steps : [];
		if (!steps.length) throw new Error("missing_transaction_steps");
		const resultKey = cmd.payload.resultKey;

		const bag: Record<string, any> = {};          // literales de pasos `value` (para $ref)
		const middle: ResolvedStmt[] = [];
		const replicated: ResolvedStmt[] = [];
		const literalResults: Record<string, SqlScalar> = {};
		const rowsAffectedAt: Record<string, number> = {};               // saveAs -> idx en middle
		const rowReadAt: Record<string, { idx: number; many: boolean }> = {};

		for (const step of steps) {
			if (!step || typeof step !== "object") throw new Error("invalid_transaction_step");

			if (step.kind === "value") {
				const v = evalValueStep(step.sql, resolveSqlArgs(step.args, bag));
				bag[step.saveAs] = v;
				literalResults[step.saveAs] = v;
				continue;
			}

			if (step.kind === "execute") {
				const stmt: ResolvedStmt = {
					sql: normalizeSql(step.sql),
					args: resolveSqlArgs(step.args, bag),
				};
				middle.push(stmt);
				replicated.push(stmt);
				if (step.saveAs) rowsAffectedAt[step.saveAs] = middle.length - 1;
				continue;
			}

			if (step.kind === "row" || step.kind === "rows") {
				// Lectura: se ejecuta en el batch pero NO se replica (no es escritura). Su
				// resultado solo se devuelve (resultKey); nunca alimenta un write posterior.
				middle.push({
					sql: normalizeSql(step.sql),
					args: resolveSqlArgs(step.args, bag),
				});
				rowReadAt[step.saveAs] = { idx: middle.length - 1, many: step.kind === "rows" };
				continue;
			}

			throw new Error(`batch_unsupported_step_kind:${(step as any).kind}`);
		}

		const lookup = (name: string, res: any[] | null, offset: number): any => {
			if (name in literalResults) return literalResults[name];
			if (name in rowsAffectedAt) {
				return res ? Number(res[offset + rowsAffectedAt[name]]?.rowsAffected ?? 0) : null;
			}
			if (name in rowReadAt) {
				if (!res) return null;
				const r = res[offset + rowReadAt[name].idx];
				return rowReadAt[name].many ? allRowsFromResult(r) : firstRowFromResult(r);
			}
			return null;
		};

		const compute = (res: any[] | null, offset: number): any => {
			if (resultKey) return lookup(resultKey, res, offset);
			// Sin resultKey: el resultado es el bag completo de nombres conocidos (como hoy).
			const out: Record<string, any> = {};
			for (const k of Object.keys(literalResults)) out[k] = literalResults[k];
			for (const k of Object.keys(rowsAffectedAt)) out[k] = lookup(k, res, offset);
			for (const k of Object.keys(rowReadAt)) out[k] = lookup(k, res, offset);
			return out;
		};

		return {
			middle,
			replicated,
			resolveResult: (res, offset) => compute(res, offset),
			storageResult: compute(null, 0),
		};
	}

	throw new Error(`batch_unsupported_command_type:${(cmd as any).type}`);
}

/** Una escritura suelta, ya validada y con la hora fijada (`rewriteCmdNowLiterals`). */
export type EscrituraPreparada = {
	opId: string;
	commandName: string;
	cmd: InternalApplyCommand;
	deviceId: string | null;
	requestHash: string;
};

/**
 * El batch atómico de una escritura: [PRAGMA] + [gate de idempotencia] + [trabajo] + [log].
 *
 * El gate va SIN `ON CONFLICT`: en un reintento (mismo `Op_Id`) viola el UNIQUE y deshace TODO el
 * batch, así que ni se duplica el trabajo ni el log. La operación está aplicada (commit) o no está.
 */
export function loteDe(e: EscrituraPreparada, createdAtMs: number) {
	const built = buildApplyBatch(e.cmd);
	const gate: ResolvedStmt = {
		sql: `INSERT INTO Applied_Operations (Op_Id, Command_Name, Request_Hash, Device_Id, Status, Result_Json, Error_Text, Created_At_Ms, Applied_At_Ms, Updated_At_Ms) VALUES (?1, ?2, ?3, ?4, 'APPLIED', ?5, NULL, ?6, ?6, ?6);`,
		args: [e.opId, e.commandName, e.requestHash, e.deviceId, stringifyJsonValue(built.storageResult), createdAtMs],
	};
	const log: ResolvedStmt = {
		sql: `INSERT INTO Sync_Changes (Op_Id, Command_Name, Statements_Json, Device_Id, Created_At_Ms) VALUES (?1, ?2, ?3, ?4, ?5);`,
		args: [e.opId, e.commandName, stableStringify(built.replicated), e.deviceId, createdAtMs],
	};
	// Índices: 0 = PRAGMA, 1 = gate, 2.. = trabajo y lecturas, último = log.
	const stmts: ResolvedStmt[] = [
		{ sql: "PRAGMA defer_foreign_keys = ON;", args: [] },
		gate,
		...built.middle,
		log,
	];
	return { stmts, built, offsetTrabajo: 2, idxLog: stmts.length - 1 };
}
