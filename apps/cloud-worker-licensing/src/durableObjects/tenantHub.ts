import type { Client } from "@libsql/client/web";
import { createDbClient } from "../server/db/clients";
import { resolveTenantDbCredentials } from "../server/db/tenantDb";
import { b64ToBytes, bytesToB64 } from "../server/utils/base64";
import { ed25519Verify, nobleForceU8 } from "../server/utils/nobleEd25519";

type Role = "tpv" | "handy" | "unknown";

type PingMsg = { type: "ping" };

type HelloSignedMsg = {
	type: "helloSigned";
	ts: number;
	nonceB64: string;
	sigB64: string;
	role?: Role;
};

type EventMsg = { type: "event"; name: string; payload?: any };

type AnyMsg = PingMsg | HelloSignedMsg | EventMsg;

type SqlScalar = string | number | boolean | null;
type SqlRef = { $ref: string };
type SqlArg = SqlScalar | SqlRef;

type ExecPayload = {
	sql: string;
	args?: SqlArg[];
};

type QueryPayload = {
	sql: string;
	args?: SqlArg[];
};

type TxStep =
	| {
		kind: "execute";
		sql: string;
		args?: SqlArg[];
		saveAs?: string;
	}
	| {
		kind: "value";
		sql: string;
		args?: SqlArg[];
		saveAs: string;
	}
	| {
		kind: "row";
		sql: string;
		args?: SqlArg[];
		saveAs: string;
	}
	| {
		kind: "rows";
		sql: string;
		args?: SqlArg[];
		saveAs: string;
	};

type TransactionPayload = {
	steps: TxStep[];
	resultKey?: string;
	beginMode?: "deferred" | "immediate" | "exclusive";
};

type InternalApplyCommand =
	| { type: "tenantDb.ping" }
	| { type: "tenantDb.exec"; payload: ExecPayload }
	| { type: "tenantDb.value"; payload: QueryPayload }
	| { type: "tenantDb.row"; payload: QueryPayload }
	| { type: "tenantDb.rows"; payload: QueryPayload }
	| { type: "tenantDb.transaction"; payload: TransactionPayload };

type LibsqlTxMode = "write" | "deferred";

const CLOUD_CHANGES_NOTIFY_MIN_INTERVAL_MS = 10_000;
const CLOUD_CHANGES_NOTIFY_DEBOUNCE_MS = 750;

// Caché en memoria (por instancia de DO) de las credenciales de la DB del
// tenant. El token de Turso es válido 7 días y se rota proactivamente cada 24h
// en `resolveTenantDbCredentials`, así que no hace falta re-resolver en cada
// consulta: basta revalidar cada cierto tiempo (o de inmediato ante un 401).
const TENANT_DB_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function safeJsonParse(s: string): any | null {
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
}

function parseJsonStrict(s: string, fieldName: string): any {
	try {
		return JSON.parse(s);
	} catch {
		throw new Error(`invalid_${fieldName}`);
	}
}

function nowMs() {
	return Date.now();
}

function isWebSocketUpgrade(req: Request): boolean {
	const h = req.headers.get("Upgrade") || "";
	return h.toLowerCase() === "websocket";
}

function roleNormalize(r: any): Role {
	const s = String(r || "").toLowerCase();
	if (s === "tpv") return "tpv";
	if (s === "handy") return "handy";
	return "unknown";
}

function isEventAllowed(role: Role, name: string): boolean {
	const n = String(name || "");
	if (!n) return false;

	if (role === "tpv") return true;

	if (role === "handy") {
		return (
			n.startsWith("handy.") ||
			n.startsWith("mesa.") ||
			n.startsWith("ticket.") ||
			n.startsWith("order.")
		);
	}

	return false;
}

function jsonResponse(data: any, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}

function isSqlRef(v: any): v is SqlRef {
	return !!v && typeof v === "object" && typeof v.$ref === "string";
}

function normalizeSql(sql: any): string {
	const out = String(sql || "").trim();
	if (!out) throw new Error("missing_sql");
	return out;
}

function toPlainValue(v: any): any {
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

function stableNormalize(v: any): any {
	if (v == null) return null;
	if (typeof v === "bigint") return Number(v);
	if (v instanceof Uint8Array) return bytesToB64(v);
	if (Array.isArray(v)) return v.map(stableNormalize);
	if (typeof v === "object") {
		const out: Record<string, any> = {};
		for (const k of Object.keys(v).sort()) {
			out[k] = stableNormalize(v[k]);
		}
		return out;
	}
	return v;
}

function stableStringify(v: any): string {
	return JSON.stringify(stableNormalize(v ?? null));
}

function stringifyJsonValue(v: any): string {
	const s = JSON.stringify(toPlainValue(v ?? null));
	return s === undefined ? "null" : s;
}

function optionalJsonFieldToStableString(
	value: unknown,
	fieldName: string,
): string | null {
	if (value === undefined || value === null) return null;

	const raw = String(value).trim();
	if (!raw) return null;

	return stableStringify(parseJsonStrict(raw, fieldName));
}

function hasOwn(obj: any, key: string): boolean {
	return !!obj && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);
}

function getFirstOwnValue(obj: any, keys: string[]): any {
	if (!obj || typeof obj !== "object") return undefined;

	for (const key of keys) {
		if (hasOwn(obj, key)) return obj[key];
	}

	return undefined;
}

function buildInternalPayloadForHash(cmd: InternalApplyCommand): any {
	return {
		type: cmd.type,
		payload: (cmd as any).payload ?? null,
	};
}

function buildCommandEnvelope(opId: string, commandName: string, args: any): any {
	return {
		op_id: opId,
		command_name: commandName,
		args: args ?? {},
	};
}

function readRequestPayloadJson(
	body: any,
	fallbackPayloadForHash: any,
): string {
	const requestPayloadJson = optionalJsonFieldToStableString(
		getFirstOwnValue(body, ["request_payload_json", "requestPayloadJson"]),
		"request_payload_json",
	);

	if (requestPayloadJson) {
		return requestPayloadJson;
	}

	const requestPayload = getFirstOwnValue(body, [
		"request_payload",
		"requestPayload",
		"request_args",
		"requestArgs",
	]);

	if (requestPayload !== undefined) {
		return stableStringify(toPlainValue(requestPayload));
	}

	const cloudPayloadJson = optionalJsonFieldToStableString(
		getFirstOwnValue(body, ["cloud_payload_json", "cloudPayloadJson"]),
		"cloud_payload_json",
	);

	if (cloudPayloadJson) {
		return cloudPayloadJson;
	}

	const cloudPayload = getFirstOwnValue(body, [
		"cloud_payload",
		"cloudPayload",
		"sync_payload",
		"syncPayload",
		"domain_payload",
		"domainPayload",
	]);

	if (cloudPayload !== undefined) {
		return stableStringify(toPlainValue(cloudPayload));
	}

	return stableStringify(fallbackPayloadForHash);
}

function readCloudPayloadJson(params: {
	body: any;
	opId: string;
	commandName: string;
	fallbackPayloadForHash: any;
}): string {
	const { body, opId, commandName, fallbackPayloadForHash } = params;

	const cloudPayloadJson = optionalJsonFieldToStableString(
		getFirstOwnValue(body, ["cloud_payload_json", "cloudPayloadJson"]),
		"cloud_payload_json",
	);

	if (cloudPayloadJson) {
		return cloudPayloadJson;
	}

	const cloudPayload = getFirstOwnValue(body, [
		"cloud_payload",
		"cloudPayload",
		"sync_payload",
		"syncPayload",
		"domain_payload",
		"domainPayload",
	]);

	if (cloudPayload !== undefined) {
		return stableStringify(toPlainValue(cloudPayload));
	}

	const domainArgs = getFirstOwnValue(body, ["args", "input", "params"]);

	if (domainArgs !== undefined) {
		return stableStringify(buildCommandEnvelope(opId, commandName, domainArgs));
	}

	return stableStringify(fallbackPayloadForHash);
}

function resolveSqlArg(v: SqlArg, bag: Record<string, any>): SqlScalar {
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

function resolveSqlArgs(raw: any, bag: Record<string, any>): SqlScalar[] {
	if (raw == null) return [];
	if (!Array.isArray(raw)) throw new Error("invalid_sql_args");
	return raw.map((v) => resolveSqlArg(v as SqlArg, bag));
}

function firstValueFromResult(result: any): any {
	const rows = result?.rows || [];
	if (!Array.isArray(rows) || rows.length === 0) return null;

	const row = rows[0];
	const cols = Array.isArray(result?.columns) ? result.columns : [];

	if (row && typeof row === "object" && cols.length > 0) {
		const firstCol = cols[0];
		if (firstCol in row) return toPlainValue((row as any)[firstCol]);
	}

	if (Array.isArray(row)) return toPlainValue(row[0] ?? null);

	if (row && typeof row === "object") {
		const firstKey = Object.keys(row)[0];
		if (firstKey) return toPlainValue((row as any)[firstKey]);
	}

	return toPlainValue(row);
}

function firstRowFromResult(result: any): any {
	const rows = result?.rows || [];
	if (!Array.isArray(rows) || rows.length === 0) return null;
	return toPlainValue(rows[0]);
}

function allRowsFromResult(result: any): any[] {
	const rows = result?.rows || [];
	if (!Array.isArray(rows)) return [];
	return rows.map((r: any) => toPlainValue(r));
}

function toLibsqlTxMode(
	beginMode?: "deferred" | "immediate" | "exclusive",
): LibsqlTxMode {
	if (beginMode === "deferred") return "deferred";
	return "write";
}

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

async function sha256Hex(raw: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(raw),
	);
	return toHex(new Uint8Array(digest));
}


function isTursoAuthError(err: unknown): boolean {
	const msg = String((err as any)?.message ?? err ?? "").toLowerCase();

	return (
		msg.includes("server returned http status 401") ||
		msg.includes("http status 401") ||
		msg.includes("unauthorized")
	);
}

function isNoSuchCloudChangesTableError(err: unknown): boolean {
	const msg = String((err as any)?.message ?? err ?? "").toLowerCase();
	return msg.includes("no such table") && msg.includes("cloud_changes");
}

function readEnvelopeMetadata(body: any, req: Request) {
	const opId = String(
		body?.opId ??
		body?.op_id ??
		req.headers.get("x-idempotency-key") ??
		"",
	).trim();

	const commandName = String(
		body?.commandName ??
		body?.command_name ??
		req.headers.get("x-command-name") ??
		"",
	).trim();

	const deviceId = String(
		body?.deviceId ??
		body?.device_id ??
		req.headers.get("x-device-id") ??
		"",
	).trim();

	return {
		opId,
		commandName,
		deviceId: deviceId || null,
	};
}

export class TenantHub {
	private sockets = new Map<string, WebSocket>();
	private roles = new Map<string, Role>();
	private authed = new Set<string>();
	private challengeByDevice = new Map<
		string,
		{ nonceB64: string; expiresAtMs: number; issuedAtMs: number }
	>();
	private pubkeyByDevice = new Map<string, string>();

	private centralDb: Client | null = null;

	private tenantDb: Client | null = null;
	private tenantDbTenantId: string | null = null;
	private tenantDbDbName: string | null = null;
	private tenantDbRotatedAtMs: number | null = null;
	private tenantDbResolvedAtMs: number | null = null;

	private cloudChangesNotifyTimer: any = null;
	private cloudChangesNotifyPending = false;
	private cloudChangesNotifyLastSentAtMs = 0;

	constructor(private state: DurableObjectState, private env: any) { }

	private getCentralDb(): Client {
		if (!this.centralDb) {
			this.centralDb = createDbClient({
				url: this.env.TURSO_DATABASE_URL,
				authToken: this.env.TURSO_AUTH_TOKEN,
			});
		}
		return this.centralDb;
	}

	private async probeTenantDb(db: Client): Promise<void> {
		await db.execute({
			sql: "SELECT 1 AS ok;",
			args: [],
		});
	}

	private clearTenantDbCache() {
		this.tenantDb = null;
		this.tenantDbTenantId = null;
		this.tenantDbDbName = null;
		this.tenantDbRotatedAtMs = null;
		this.tenantDbResolvedAtMs = null;
	}

	private async resolveTenantDbClient(
		tenantId: string,
		forceRotate: boolean,
	): Promise<Client> {
		// Resolución LOCAL (antes era una llamada HTTP firmada al worker de
		// licensing por service binding). Ahora ambos viven en `tpv-api`.
		const resolved = await resolveTenantDbCredentials(
			this.getCentralDb(),
			this.env,
			tenantId,
			forceRotate,
		);

		const dbTenant = createDbClient({
			url: resolved.tursoUrl,
			authToken: resolved.tursoAuthToken,
		});

		await this.probeTenantDb(dbTenant);

		this.tenantDb = dbTenant;
		this.tenantDbTenantId = tenantId;
		this.tenantDbDbName = resolved.dbName;
		this.tenantDbRotatedAtMs = resolved.rotatedAtMs;
		this.tenantDbResolvedAtMs = nowMs();

		return dbTenant;
	}

	private isTenantDbCacheFresh(tenantId: string): boolean {
		return (
			this.tenantDb != null &&
			this.tenantDbTenantId === tenantId &&
			this.tenantDbResolvedAtMs != null &&
			nowMs() - this.tenantDbResolvedAtMs < TENANT_DB_CACHE_TTL_MS
		);
	}

	private async getTenantDb(tenantId: string): Promise<Client> {
		// Sirve la credencial cacheada si sigue fresca (TTL). Pasado el TTL se
		// revalida (resolución local barata); ante un 401 se fuerza rotación.
		if (this.isTenantDbCacheFresh(tenantId)) {
			return this.tenantDb!;
		}

		try {
			return await this.resolveTenantDbClient(tenantId, false);
		} catch (e) {
			if (!isTursoAuthError(e)) throw e;
			return await this.resolveTenantDbClient(tenantId, true);
		}
	}

	private async withTenantDbRetry<T>(
		tenantId: string,
		run: (db: Client) => Promise<T>,
	): Promise<T> {
		const db = await this.getTenantDb(tenantId);

		try {
			return await run(db);
		} catch (e) {
			if (!isTursoAuthError(e)) throw e;
		}

		this.clearTenantDbCache();
		const rotatedDb = await this.resolveTenantDbClient(tenantId, true);
		return await run(rotatedDb);
	}

	private async loadDeviceFromCentral(
		tenantId: string,
		deviceId: string,
	): Promise<{ role: Role; pubkeyB64: string | null; revoked: boolean }> {
		const dbCentral = this.getCentralDb();
		const r = await dbCentral.execute({
			sql: `
				SELECT role, device_pubkey_b64, revoked_at_ms
				FROM devices
				WHERE tenant_id=? AND device_id=?
				LIMIT 1
			`,
			args: [tenantId, deviceId],
		});

		const row = r.rows?.[0] as any | undefined;
		if (!row) return { role: "unknown", pubkeyB64: null, revoked: true };

		const role = roleNormalize(row.role);
		const pubkeyB64 = String(row.device_pubkey_b64 || "").trim() || null;
		const revoked = Boolean(row.revoked_at_ms);

		return { role, pubkeyB64, revoked };
	}

	private async touchLastSeen(tenantId: string, deviceId: string) {
		const dbCentral = this.getCentralDb();
		const now = nowMs();
		await dbCentral.execute({
			sql: `UPDATE devices SET last_seen_at_ms=?, updated_at_ms=? WHERE tenant_id=? AND device_id=?`,
			args: [now, now, tenantId, deviceId],
		});
	}

	private async runExecOnExecutor(
		executor: any,
		payload: ExecPayload,
		bag: Record<string, any> = {},
	): Promise<number> {
		const sql = normalizeSql(payload?.sql);
		const args = resolveSqlArgs(payload?.args, bag);
		const res = await executor.execute({ sql, args });
		return Number(res?.rowsAffected ?? 0);
	}

	private async runValueOnExecutor(
		executor: any,
		payload: QueryPayload,
		bag: Record<string, any> = {},
	): Promise<any> {
		const sql = normalizeSql(payload?.sql);
		const args = resolveSqlArgs(payload?.args, bag);
		const res = await executor.execute({ sql, args });
		return firstValueFromResult(res);
	}

	private async runRowOnExecutor(
		executor: any,
		payload: QueryPayload,
		bag: Record<string, any> = {},
	): Promise<any> {
		const sql = normalizeSql(payload?.sql);
		const args = resolveSqlArgs(payload?.args, bag);
		const res = await executor.execute({ sql, args });
		return firstRowFromResult(res);
	}

	private async runRowsOnExecutor(
		executor: any,
		payload: QueryPayload,
		bag: Record<string, any> = {},
	): Promise<any[]> {
		const sql = normalizeSql(payload?.sql);
		const args = resolveSqlArgs(payload?.args, bag);
		const res = await executor.execute({ sql, args });
		return allRowsFromResult(res);
	}

	private async runTransactionStepsOnExecutor(
		executor: any,
		payload: TransactionPayload,
	): Promise<any> {
		const steps = Array.isArray(payload?.steps) ? payload.steps : [];
		if (!steps.length) throw new Error("missing_transaction_steps");

		const bag: Record<string, any> = {};

		for (const step of steps) {
			if (!step || typeof step !== "object") {
				throw new Error("invalid_transaction_step");
			}

			if (step.kind === "execute") {
				const res = await this.runExecOnExecutor(executor, step, bag);

				if (step.saveAs) {
					bag[step.saveAs] = res;
				}

				continue;
			}

			if (step.kind === "value") {
				bag[step.saveAs] = await this.runValueOnExecutor(executor, step, bag);
				continue;
			}

			if (step.kind === "row") {
				bag[step.saveAs] = await this.runRowOnExecutor(executor, step, bag);
				continue;
			}

			if (step.kind === "rows") {
				bag[step.saveAs] = await this.runRowsOnExecutor(executor, step, bag);
				continue;
			}

			throw new Error("unknown_transaction_step_kind");
		}

		if (payload?.resultKey) {
			return payload.resultKey in bag ? bag[payload.resultKey] : null;
		}

		return bag;
	}

	private async runExec(
		tenantId: string,
		payload: ExecPayload,
		bag: Record<string, any> = {},
	): Promise<number> {
		return await this.withTenantDbRetry(tenantId, async (db) => {
			return await this.runExecOnExecutor(db, payload, bag);
		});
	}

	private async runValue(
		tenantId: string,
		payload: QueryPayload,
		bag: Record<string, any> = {},
	): Promise<any> {
		return await this.withTenantDbRetry(tenantId, async (db) => {
			return await this.runValueOnExecutor(db, payload, bag);
		});
	}

	private async runRow(
		tenantId: string,
		payload: QueryPayload,
		bag: Record<string, any> = {},
	): Promise<any> {
		return await this.withTenantDbRetry(tenantId, async (db) => {
			return await this.runRowOnExecutor(db, payload, bag);
		});
	}

	private async runRows(
		tenantId: string,
		payload: QueryPayload,
		bag: Record<string, any> = {},
	): Promise<any[]> {
		return await this.withTenantDbRetry(tenantId, async (db) => {
			return await this.runRowsOnExecutor(db, payload, bag);
		});
	}

	private async runTransaction(
		tenantId: string,
		payload: TransactionPayload,
	): Promise<any> {
		return await this.withTenantDbRetry(tenantId, async (db) => {
			const txMode = toLibsqlTxMode(payload?.beginMode);
			const tx = await db.transaction(txMode);

			try {
				const out = await this.runTransactionStepsOnExecutor(tx, payload);
				await tx.commit();
				return out;
			} catch (e) {
				try {
					await tx.rollback();
				} catch { }
				throw e;
			}
		});
	}

	private async applyInternalCommandOnExecutor(
		tenantId: string,
		executor: any,
		cmd: InternalApplyCommand,
	): Promise<any> {
		switch (cmd.type) {
			case "tenantDb.ping": {
				await executor.execute({ sql: "SELECT 1", args: [] });

				return {
					ok: true,
					type: cmd.type,
					tenantId,
					ts: nowMs(),
				};
			}

			case "tenantDb.exec":
				return await this.runExecOnExecutor(executor, cmd.payload);

			case "tenantDb.value":
				return await this.runValueOnExecutor(executor, cmd.payload);

			case "tenantDb.row":
				return await this.runRowOnExecutor(executor, cmd.payload);

			case "tenantDb.rows":
				return await this.runRowsOnExecutor(executor, cmd.payload);

			case "tenantDb.transaction":
				return await this.runTransactionStepsOnExecutor(executor, cmd.payload);

			default: {
				const neverCmd: never = cmd;
				throw new Error(
					`unknown_command:${String((neverCmd as any)?.type || "unknown")}`,
				);
			}
		}
	}

	private async applyInternalCommand(
		tenantId: string,
		cmd: InternalApplyCommand,
	): Promise<any> {
		switch (cmd.type) {
			case "tenantDb.ping": {
				await this.withTenantDbRetry(tenantId, async (db) => {
					await db.execute({ sql: "SELECT 1", args: [] });
				});

				return {
					ok: true,
					type: cmd.type,
					tenantId,
					ts: nowMs(),
				};
			}

			case "tenantDb.exec":
				return await this.runExec(tenantId, cmd.payload);

			case "tenantDb.value":
				return await this.runValue(tenantId, cmd.payload);

			case "tenantDb.row":
				return await this.runRow(tenantId, cmd.payload);

			case "tenantDb.rows":
				return await this.runRows(tenantId, cmd.payload);

			case "tenantDb.transaction":
				return await this.runTransaction(tenantId, cmd.payload);

			default: {
				const neverCmd: never = cmd;
				throw new Error(
					`unknown_command:${String((neverCmd as any)?.type || "unknown")}`,
				);
			}
		}
	}

	private async applyInternalCommandIdempotent(params: {
		tenantId: string;
		cmd: InternalApplyCommand;
		opId: string;
		commandName: string;
		deviceId?: string | null;
		requestPayloadJson: string;
		cloudPayloadJson: string;
	}): Promise<any> {
		const {
			tenantId,
			cmd,
			opId,
			commandName,
			deviceId,
			requestPayloadJson,
			cloudPayloadJson,
		} = params;

		const op = opId.trim();
		const command = commandName.trim();

		if (!op) {
			throw new Error("missing_op_id");
		}

		if (!command) {
			throw new Error("missing_command_name");
		}

		const requestHash = await sha256Hex(requestPayloadJson);
		const createdAtMs = nowMs();

		return await this.withTenantDbRetry(tenantId, async (db) => {
			const tx = await db.transaction("write");
			let cloudChangeInserted = false;

			try {
				const existing = await tx.execute({
					sql: `
						SELECT
						  Command_Name AS command_name,
						  Request_Hash AS request_hash,
						  Status AS status,
						  Result_Json AS result_json,
						  Error_Text AS error_text
						FROM Applied_Operations
						WHERE Op_Id = ?1
						LIMIT 1;
					`,
					args: [op],
				});

				const existingRow = existing.rows?.[0] as any | undefined;

				if (existingRow) {
					const existingCommand = String(existingRow.command_name || "");
					const existingHash = String(existingRow.request_hash || "");
					const status = String(existingRow.status || "");

					if (existingCommand !== command) {
						throw new Error("idempotency_command_mismatch");
					}

					if (existingHash !== requestHash) {
						throw new Error("idempotency_payload_mismatch");
					}

					if (status === "APPLIED") {
						const raw = String(existingRow.result_json ?? "null");
						const parsed = safeJsonParse(raw);
						await tx.commit();
						return parsed;
					}

					if (status === "PROCESSING") {
						throw new Error("idempotency_operation_processing");
					}

					if (status === "FAILED") {
						throw new Error(
							`idempotency_operation_failed:${String(
								existingRow.error_text || "unknown_error",
							)}`,
						);
					}

					throw new Error(`idempotency_bad_status:${status}`);
				}

				await tx.execute({
					sql: `
						INSERT INTO Applied_Operations (
						  Op_Id,
						  Command_Name,
						  Request_Hash,
						  Device_Id,
						  Status,
						  Result_Json,
						  Error_Text,
						  Created_At_Ms,
						  Applied_At_Ms,
						  Updated_At_Ms
						)
						VALUES (
						  ?1,
						  ?2,
						  ?3,
						  ?4,
						  'PROCESSING',
						  NULL,
						  NULL,
						  ?5,
						  NULL,
						  ?6
						);
					`,
					args: [
						op,
						command,
						requestHash,
						deviceId || null,
						createdAtMs,
						createdAtMs,
					],
				});

				const result = await this.applyInternalCommandOnExecutor(
					tenantId,
					tx,
					cmd,
				);

				const appliedAtMs = nowMs();
				const resultJson = stringifyJsonValue(result);

				await tx.execute({
					sql: `
						UPDATE Applied_Operations
						SET
						  Status = 'APPLIED',
						  Result_Json = ?3,
						  Error_Text = NULL,
						  Applied_At_Ms = ?4,
						  Updated_At_Ms = ?5
						WHERE Op_Id = ?1
						  AND Command_Name = ?2;
					`,
					args: [op, command, resultJson, appliedAtMs, appliedAtMs],
				});

				try {
					await tx.execute({
						sql: `
							INSERT INTO Cloud_Changes (
							  Op_Id,
							  Command_Name,
							  Device_Id,
							  Payload_Json,
							  Result_Json,
							  Created_At_Ms
							)
							VALUES (?1, ?2, ?3, ?4, ?5, ?6);
						`,
						args: [
							op,
							command,
							deviceId || null,
							cloudPayloadJson,
							resultJson,
							appliedAtMs,
						],
					});

					cloudChangeInserted = true;
				} catch (e) {
					if (!isNoSuchCloudChangesTableError(e)) {
						throw e;
					}
				}

				await tx.commit();

				if (cloudChangeInserted) {
					this.scheduleCloudChangesAvailable(tenantId);
				}

				return result;
			} catch (e) {
				try {
					await tx.rollback();
				} catch { }
				throw e;
			}
		});
	}

	private send(ws: WebSocket, obj: any) {
		try {
			ws.send(JSON.stringify(obj));
		} catch { }
	}

	private broadcast(obj: any, exceptDeviceId?: string) {
		const msg = JSON.stringify(obj);
		for (const [did, ws] of this.sockets) {
			if (exceptDeviceId && did === exceptDeviceId) continue;
			try {
				ws.send(msg);
			} catch { }
		}
	}

	private broadcastAuthed(obj: any, exceptDeviceId?: string) {
		const msg = JSON.stringify(obj);

		for (const [did, ws] of this.sockets) {
			if (exceptDeviceId && did === exceptDeviceId) continue;
			if (!this.authed.has(did)) continue;

			try {
				ws.send(msg);
			} catch { }
		}
	}

	private scheduleCloudChangesAvailable(tenantId: string) {
		this.cloudChangesNotifyPending = true;

		if (this.cloudChangesNotifyTimer) return;

		const now = nowMs();
		const elapsed = this.cloudChangesNotifyLastSentAtMs
			? now - this.cloudChangesNotifyLastSentAtMs
			: Number.POSITIVE_INFINITY;

		const delay =
			elapsed >= CLOUD_CHANGES_NOTIFY_MIN_INTERVAL_MS
				? CLOUD_CHANGES_NOTIFY_DEBOUNCE_MS
				: Math.max(
					CLOUD_CHANGES_NOTIFY_DEBOUNCE_MS,
					CLOUD_CHANGES_NOTIFY_MIN_INTERVAL_MS - elapsed,
				);

		this.cloudChangesNotifyTimer = setTimeout(() => {
			this.cloudChangesNotifyTimer = null;
			this.flushCloudChangesAvailable(tenantId);
		}, delay);
	}

	private flushCloudChangesAvailable(tenantId: string) {
		if (!this.cloudChangesNotifyPending) return;

		this.cloudChangesNotifyPending = false;

		const ts = nowMs();
		this.cloudChangesNotifyLastSentAtMs = ts;

		this.broadcastAuthed({
			type: "cloud_changes_available",
			tenantId,
			ts,
		});
	}

	private issueChallenge(deviceId: string) {
		const nonce = new Uint8Array(32);
		crypto.getRandomValues(nonce);
		const nonceB64 = bytesToB64(nonce);

		const issuedAtMs = nowMs();
		const expiresAtMs = issuedAtMs + 60_000;

		this.challengeByDevice.set(deviceId, {
			nonceB64,
			expiresAtMs,
			issuedAtMs,
		});

		return { nonceB64, expiresAtMs };
	}

	private async verifyHelloSigned(params: {
		tenantId: string;
		deviceId: string;
		roleHeader: Role;
		msg: HelloSignedMsg;
		pubkeyB64Hint?: string | null;
	}): Promise<{ roleFinal: Role }> {
		const { tenantId, deviceId, roleHeader, msg, pubkeyB64Hint } = params;

		const ch = this.challengeByDevice.get(deviceId);
		if (!ch) throw new Error("missing_challenge");
		if (msg.nonceB64 !== ch.nonceB64) throw new Error("challenge_mismatch");
		if (nowMs() > ch.expiresAtMs) throw new Error("challenge_expired");

		const MAX_SKEW_MS = 2 * 60 * 1000;
		if (!Number.isFinite(msg.ts)) throw new Error("bad_ts");
		if (Math.abs(nowMs() - msg.ts) > MAX_SKEW_MS) {
			throw new Error("ts_out_of_range");
		}

		let pubkeyB64 = (pubkeyB64Hint || "").trim();
		if (!pubkeyB64) pubkeyB64 = (this.pubkeyByDevice.get(deviceId) || "").trim();

		let roleFinal: Role = roleHeader;

		const centralInfo = await this.loadDeviceFromCentral(tenantId, deviceId);
		if (centralInfo.revoked) throw new Error("device_revoked");
		if (centralInfo.pubkeyB64) pubkeyB64 = centralInfo.pubkeyB64;
		roleFinal = centralInfo.role !== "unknown" ? centralInfo.role : roleHeader;

		if (!pubkeyB64) throw new Error("device_pubkey_not_registered");

		this.pubkeyByDevice.set(deviceId, pubkeyB64);

		const payload = new TextEncoder().encode(
			`${msg.ts}\nWS_HELLO\n${tenantId}\n${deviceId}\n${msg.nonceB64}`,
		);

		const pub = nobleForceU8(b64ToBytes(pubkeyB64));
		const sig = nobleForceU8(b64ToBytes(msg.sigB64));

		const ok = await ed25519Verify(sig, payload, pub);
		if (!ok) throw new Error("bad_ws_signature");

		return { roleFinal };
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/internal/revoke" && request.method === "POST") {
			const body = safeJsonParse(await request.text()) || {};
			const deviceId = String(body.deviceId || "").trim();
			const ws = deviceId ? this.sockets.get(deviceId) : null;

			if (ws) {
				try {
					ws.close(4001, "revoked");
				} catch { }
				this.sockets.delete(deviceId);
				this.roles.delete(deviceId);
				this.authed.delete(deviceId);
				this.challengeByDevice.delete(deviceId);
			}

			return new Response("OK", { status: 200 });
		}

		if (url.pathname === "/internal/apply" && request.method === "POST") {
			const tenantId = String(request.headers.get("x-tenant-id") || "").trim();
			if (!tenantId) {
				return jsonResponse({ ok: false, error: "missing_tenant_id" }, 400);
			}

			const body = safeJsonParse(await request.text()) || {};
			const type = String(body?.type || "").trim();

			if (!type) {
				return jsonResponse({ ok: false, error: "missing_command_type" }, 400);
			}

			const { opId, commandName, deviceId } = readEnvelopeMetadata(
				body,
				request,
			);

			if (!opId) {
				return jsonResponse({ ok: false, error: "missing_op_id" }, 400);
			}

			if (!commandName) {
				return jsonResponse({ ok: false, error: "missing_command_name" }, 400);
			}

			const cmd = {
				type: body.type,
				payload: body.payload,
			} as InternalApplyCommand;

			const fallbackPayloadForHash = buildInternalPayloadForHash(cmd);
			const requestPayloadJson = readRequestPayloadJson(
				body,
				fallbackPayloadForHash,
			);
			const cloudPayloadJson = readCloudPayloadJson({
				body,
				opId,
				commandName,
				fallbackPayloadForHash,
			});

			try {
				const result = await this.applyInternalCommandIdempotent({
					tenantId,
					cmd,
					opId,
					commandName,
					deviceId,
					requestPayloadJson,
					cloudPayloadJson,
				});

				return jsonResponse({ ok: true, data: result }, 200);
			} catch (e: any) {
				const msg = String(e?.message || e);

				const status =
					msg === "idempotency_payload_mismatch"
						? 409
						: msg === "idempotency_command_mismatch"
							? 409
							: msg === "idempotency_operation_processing"
								? 409
								: 400;

				return jsonResponse(
					{
						ok: false,
						error: msg,
					},
					status,
				);
			}
		}

		if (url.pathname !== "/ws") {
			return new Response("Not found", { status: 404 });
		}

		if (!isWebSocketUpgrade(request)) {
			return new Response("Expected WebSocket", { status: 426 });
		}

		const tenantId = request.headers.get("x-tenant-id") || "";
		const deviceId = request.headers.get("x-device-id") || "";
		const roleHeader = roleNormalize(request.headers.get("x-role") || "unknown");
		const pubkeyHint =
			(request.headers.get("x-device-pubkey-b64") || "").trim() || null;

		if (!tenantId || !deviceId) {
			return new Response("missing identity", { status: 400 });
		}

		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		server.accept();

		const prev = this.sockets.get(deviceId);
		if (prev) {
			try {
				prev.close(4000, "replaced");
			} catch { }
		}

		this.sockets.set(deviceId, server);
		this.roles.set(deviceId, roleHeader);
		this.authed.delete(deviceId);

		this.state.waitUntil(this.touchLastSeen(tenantId, deviceId));

		const ch = this.issueChallenge(deviceId);

		this.send(server, {
			type: "connected",
			tenantId,
			deviceId,
			role: roleHeader,
			auth: "required",
		});

		this.send(server, {
			type: "challenge",
			nonceB64: ch.nonceB64,
			expiresAtMs: ch.expiresAtMs,
		});

		this.broadcast(
			{
				type: "presence",
				action: "join",
				deviceId,
				role: roleHeader,
				authed: false,
			},
			deviceId,
		);

		server.addEventListener("message", (ev) => {
			const data = typeof ev.data === "string" ? ev.data : "";
			const msg = safeJsonParse(data) as AnyMsg | null;

			if (!msg || typeof msg.type !== "string") {
				this.send(server, { type: "error", error: "bad_json" });
				return;
			}

			if (msg.type === "ping") {
				this.send(server, { type: "pong", ts: nowMs() });
				this.state.waitUntil(this.touchLastSeen(tenantId, deviceId));
				return;
			}

			if (msg.type === "helloSigned") {
				this.state.waitUntil(
					(async () => {
						try {
							const { roleFinal } = await this.verifyHelloSigned({
								tenantId,
								deviceId,
								roleHeader,
								msg,
								pubkeyB64Hint: pubkeyHint,
							});

							this.authed.add(deviceId);
							this.roles.set(deviceId, roleFinal);

							this.send(server, {
								type: "hello_ok",
								role: roleFinal,
								authed: true,
							});

							this.broadcast(
								{
									type: "presence",
									action: "auth",
									deviceId,
									role: roleFinal,
									authed: true,
								},
								deviceId,
							);
						} catch (e: any) {
							const err = String(e?.message || e);
							this.send(server, {
								type: "error",
								error: "hello_failed",
								details: err,
							});
							try {
								server.close(4003, "auth_failed");
							} catch { }
						}
					})(),
				);
				return;
			}

			if (!this.authed.has(deviceId)) {
				this.send(server, { type: "error", error: "not_authenticated" });
				return;
			}

			if (msg.type === "event") {
				const role = this.roles.get(deviceId) || roleHeader;
				const name = String(msg.name || "");

				if (!isEventAllowed(role, name)) {
					this.send(server, {
						type: "error",
						error: "forbidden_event",
						name,
					});
					return;
				}

				if (name === "tenantDb.ping") {
					this.state.waitUntil(
						(async () => {
							try {
								await this.withTenantDbRetry(tenantId, async (db) => {
									await db.execute({ sql: "SELECT 1", args: [] });
								});
								this.send(server, { type: "event_ack", name, ok: true });
							} catch (e: any) {
								this.send(server, {
									type: "event_ack",
									name,
									ok: false,
									error: String(e?.message || e),
								});
							}
						})(),
					);
					return;
				}

				this.broadcast(
					{
						type: "event",
						from: deviceId,
						role,
						name,
						payload: msg.payload ?? null,
						ts: nowMs(),
					},
					deviceId,
				);
				return;
			}

			this.send(server, { type: "error", error: "unknown_type" });
		});

		server.addEventListener("close", () => {
			this.sockets.delete(deviceId);
			this.roles.delete(deviceId);
			this.authed.delete(deviceId);
			this.challengeByDevice.delete(deviceId);
			this.broadcast({ type: "presence", action: "leave", deviceId }, deviceId);
		});

		server.addEventListener("error", () => {
			try {
				server.close(1011, "ws_error");
			} catch { }
		});

		return new Response(null, { status: 101, webSocket: client });
	}
}