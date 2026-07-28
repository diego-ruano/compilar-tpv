import type { Client } from "@libsql/client/web";
import { createDbClient } from "../server/db/clients";
import { resolveTenantDbCredentials, ensureTenantMigrated } from "../server/db/tenantDb";
import { b64ToBytes, bytesToB64 } from "../server/utils/base64";
import { ed25519Verify, nobleForceU8 } from "../server/utils/nobleEd25519";
import { verifyInternalWorkerRequest } from "../lib/internalAuth";
import { ingestToAxiom } from "../observability/axiom";

type Role = "tpv" | "handy" | "unknown";

// SYNC-16 (hibernación): TODO el estado de una sesión WS vive aquí, adosado al propio socket
// (`serializeAttachment`), no en campos de la instancia del DO. Con la WebSocket Hibernation API el
// DO se evacúa de memoria mientras las conexiones están ociosas y vuelve con los campos vacíos, así
// que cualquier `Map` por dispositivo se perdería. El attachment sobrevive a la hibernación.
// Límite: 16 KB serializados (aquí ocupamos ~200 bytes).
type WsAttachment = {
	tenantId: string;
	deviceId: string;
	/** Rol vigente: el de la cabecera `x-role` al conectar; lo pisa el rol real (BD central) al autenticar. */
	role: Role;
	authed: boolean;
	/** Clave pública conocida del dispositivo (pista de cabecera o la confirmada en el hello). */
	pubkeyB64: string | null;
	/** Challenge pendiente. SYNC-07: se consume (a `null`) en el primer intento de verificación. */
	challenge: { nonceB64: string; expiresAtMs: number } | null;
};

type PingMsg = { type: "ping" };

type HelloSignedMsg = {
	type: "helloSigned";
	ts: number;
	nonceB64: string;
	sigB64: string;
	role?: Role;
};

type EventMsg = { type: "event"; name: string; payload?: any };

// Escritura de la Main por WS: lleva el comando interno (mismo envelope que
// `/internal/apply`) para aplicarse en el motor idempotente del DO.
type ApplyMsg = {
	type: "apply";
	opId?: string;
	op_id?: string;
	commandName?: string;
	command_name?: string;
	command?: { type: string; payload?: any };
	cloud_payload?: any;
	cloudPayload?: any;
	cloud_payload_json?: string;
	cloudPayloadJson?: string;
	request_payload?: any;
	requestPayload?: any;
};

type AnyMsg = PingMsg | HelloSignedMsg | EventMsg | ApplyMsg;

type SqlScalar = string | number | boolean | null;
type SqlRef = { $ref: string };
type SqlArg = SqlScalar | SqlRef;

// Sentencia de escritura ya resuelta (sin $ref): lo que se reenvía/persiste para la Main.
type ResolvedStmt = { sql: string; args: SqlScalar[] };

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


// Caché en memoria (por instancia de DO) de las credenciales de la DB del
// tenant. El token de Turso es válido 7 días y se rota proactivamente cada 24h
// en `resolveTenantDbCredentials`, así que no hace falta re-resolver en cada
// consulta: basta revalidar cada cierto tiempo (o de inmediato ante un 401).
const TENANT_DB_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

// SYNC-08: ventana mínima entre escrituras de `last_seen_at_ms` por dispositivo en la BD central.
// Absorbe los pings (cada 30 s) sin perder utilidad de presencia (granularidad de minutos basta).
const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;

// ---- SYNC-12: purga del log de sync en la nube ------------------------------
// `Sync_Changes` y `Applied_Operations` crecían sin límite; el catch-up escanea `Sync_Changes`
// cada reconexión. Purgamos con SUELO por el checkpoint mínimo de las Main activas (nunca borramos
// algo que una Main aún no ha consumido) y con TTL (solo filas suficientemente antiguas).
const PURGE_INTERVAL_MS = 60 * 60 * 1000; // como mucho una purga por hora y por instancia de DO
const CHECKPOINT_ACTIVE_MS = 7 * 24 * 60 * 60 * 1000; // una Main cuenta para el suelo si reportó < 7 días
const PURGE_SEQ_MARGIN = 1000; // holgura de Seq por debajo del suelo (cubre solape catch-up/live)
const SYNC_CHANGES_TTL_MS = 7 * 24 * 60 * 60 * 1000; // no borrar cambios de menos de 7 días
const APPLIED_OPS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // idempotencia: un reintento nunca llega tan tarde

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

// ---- Determinismo del tiempo en las escrituras ------------------------------
// El reloj lo pone el dispositivo emisor (Main o Handy) vía la cabecera
// `X-Client-Now`, NO el servidor: una sentencia que viajara con `datetime('now')`
// se reevaluaría aquí (UTC) y en cada re-apply, divergiendo entre Main/nube/Handy.
// Resolvemos el `datetime('now','localtime')` a un literal fijo antes de ejecutar y
// de registrarlo en `Sync_Changes`. Si el cliente no mandó hora, se fija una del
// servidor UNA sola vez (sigue siendo determinista, solo que en UTC).

const CLIENT_NOW_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function serverNowFixed(): string {
	return new Date().toISOString().slice(0, 19).replace("T", " ");
}

// Margen máximo: offset de zona horaria (±14 h) + 5 min de deriva de reloj.
// Esto bloquea inyecciones de fechas arbitrarias (pasadas/futuras) sin romper
// ningún timezone legítimo. El valor se trata como naive-UTC para la comparación.
const MAX_CLIENT_NOW_DRIFT_MS = (14 * 60 + 5) * 60 * 1000;

// Devuelve el literal `YYYY-MM-DD HH:MM:SS` SOLO si el emisor mandó una hora válida y dentro de la
// deriva admisible; `null` si falta o es inaceptable (formato/deriva). NO cae a UTC en silencio: esa
// decisión la toma el llamador (ver el guard `missing_client_now` en applyInternalCommandIdempotent).
function parseClientNow(raw: unknown): string | null {
	const s = String(raw ?? "").trim();
	if (!CLIENT_NOW_RE.test(s)) return null;
	const clientMs = new Date(s.replace(" ", "T") + "Z").getTime();
	if (Math.abs(Date.now() - clientMs) > MAX_CLIENT_NOW_DRIFT_MS) return null;
	return s;
}

// ¿Alguna sentencia del comando lleva una forma `datetime('now',...)`/`date('now',...)` SIN resolver?
// (misma señal `('now'` que usa `rewriteNowInSql`.) Si la hay, EXIGIMOS X-Client-Now para fijarla a
// literal determinista; si no, el comando ya viene con literales (p. ej. desde la Main) y no hace falta.
function sqlHasNowLiteral(sql: unknown): boolean {
	return typeof sql === "string" && sql.includes("('now'");
}

function commandHasNowLiteral(cmd: InternalApplyCommand): boolean {
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
function rewriteNowInSql(sql: string, dt: string): string {
	if (typeof sql !== "string" || !sql.includes("('now'")) return sql;
	const d = dt.slice(0, 10);
	return sql
		.split("datetime('now','localtime')").join(`'${dt}'`)
		.split("date('now','localtime')").join(`'${d}'`);
}

function rewriteCmdNowLiterals(
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

// Evalúa en JS un paso `value` para no gastar un round trip a Turso por cada uno.
// Cubre el set CERRADO de formas que generan los *.commands.ts (echo de un literal,
// constante numérica, o concatenación 'prefijo' || ?N). Cualquier otra forma lanza,
// para no resolver mal en silencio (fail-fast: lo detectarían los tests).
function evalValueStep(sql: string, args: SqlScalar[]): SqlScalar {
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
function isUniqueOpIdViolation(e: any): boolean {
	const m = String(e?.message ?? e ?? "").toLowerCase();
	return m.includes("unique constraint failed") && m.includes("op_id");
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
	// SYNC-16: este DO usa la WebSocket Hibernation API. Mientras las conexiones están ociosas el
	// runtime evacúa el objeto de memoria (deja de facturar duración) y lo despierta al llegar un
	// mensaje real. Consecuencia de diseño: NO puede haber estado de sesión en campos de instancia.
	//   · lo que describe a un socket        → su attachment (`WsAttachment`)
	//   · el censo de conexiones             → `state.getWebSockets()` (etiquetadas por deviceId)
	// Lo único que queda abajo son cachés best-effort que pueden perderse sin consecuencias.

	// SYNC-08: último `last_seen` empujado a la BD central por dispositivo (throttle en memoria).
	// Se pierde al hibernar: como mucho provoca un UPDATE extra tras despertar. Aceptable.
	private lastSeenPushedAtMs = new Map<string, number>();
	// SYNC-12: instante de la última purga del log de sync (throttle en memoria del DO).
	private lastPurgeAtMs = 0;

	private centralDb: Client | null = null;

	private tenantDb: Client | null = null;
	private tenantDbTenantId: string | null = null;
	private tenantDbDbName: string | null = null;
	private tenantDbRotatedAtMs: number | null = null;
	private tenantDbResolvedAtMs: number | null = null;

	constructor(private state: DurableObjectState, private env: any) {
		// SYNC-16: el latido (cada 30 s por dispositivo) se responde EN EL EDGE, sin despertar al DO
		// ni facturar duración. Es lo que hace que un hub con conexiones abiertas pero ociosas (la
		// mayor parte del día en hostelería) cueste prácticamente cero.
		// ⚠️ El par casa cadenas EXACTAS: debe coincidir byte a byte con lo que envían
		// `useMainSocket`/`useHandySocket` (`JSON.stringify({ type: "ping" })`). Si algún día cambia
		// el formato del latido en el frontend, hay que cambiarlo aquí o el DO despertará en cada uno.
		this.state.setWebSocketAutoResponse(
			new WebSocketRequestResponsePair(
				JSON.stringify({ type: "ping" }),
				JSON.stringify({ type: "pong" }),
			),
		);
	}

	// ---- SYNC-16: helpers de sesión sobre la Hibernation API --------------------------------

	/** Lee el attachment de un socket (o `null` si no lo tiene / está corrupto). */
	private att(ws: WebSocket): WsAttachment | null {
		try {
			return (ws.deserializeAttachment() as WsAttachment | null) ?? null;
		} catch {
			return null;
		}
	}

	/** Persiste el attachment. Hay que llamarlo tras CADA mutación del estado de sesión. */
	private setAtt(ws: WebSocket, att: WsAttachment): void {
		try {
			ws.serializeAttachment(att);
		} catch {
			/* nunca romper el flujo del WS por el attachment */
		}
	}

	/** Sockets vivos de un dispositivo (los cerrados pueden seguir apareciendo en getWebSockets). */
	private liveSocketsFor(deviceId: string, except?: WebSocket): WebSocket[] {
		const out: WebSocket[] = [];
		for (const ws of this.state.getWebSockets(deviceId)) {
			if (except && ws === except) continue;
			// 1 = OPEN. Filtramos explícitamente porque `getWebSockets` puede devolver sockets ya
			// cerrados (documentado), lo que falsearía el "¿me han reemplazado?" y el freeze.
			if (ws.readyState === 1) out.push(ws);
		}
		return out;
	}

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
		// Activamos las FOREIGN KEYS en la conexión del tenant: la BD local de la Main las
		// aplica (`PRAGMA foreign_keys=ON`), así que la nube debe enforcearlas igual para no
		// aceptar estados que luego la Main rechace al reproducir (y para que CASCADE/SET NULL
		// se comporten idénticamente en ambos lados).
		await db.execute({ sql: "PRAGMA foreign_keys = ON;", args: [] });
		await db.execute({
			sql: "SELECT 1 AS ok;",
			args: [],
		});
		// Garantizamos la tabla de log de sync UNA vez al resolver la conexión (autocommit,
		// caché de 6 h) en lugar de un CREATE TABLE IF NOT EXISTS por cada escritura. La tabla
		// persiste en Turso, así que las escrituras dentro del TTL ya la encuentran creada.
		await db.execute(`
			CREATE TABLE IF NOT EXISTS Sync_Changes (
				Seq INTEGER PRIMARY KEY AUTOINCREMENT,
				Op_Id TEXT NOT NULL,
				Command_Name TEXT,
				Statements_Json TEXT NOT NULL,
				Device_Id TEXT,
				Created_At_Ms INTEGER NOT NULL
			);
		`);
		// SYNC-12: checkpoint reportado por cada Main (su `Last_Seq` al hacer catch-up). Es el SUELO
		// de la purga: nunca se borra un `Sync_Changes.Seq` por encima del mínimo de las Main activas.
		await db.execute(`
			CREATE TABLE IF NOT EXISTS Sync_Main_Checkpoints (
				Device_Id TEXT PRIMARY KEY,
				Last_Seq INTEGER NOT NULL,
				Updated_At_Ms INTEGER NOT NULL
			);
		`);
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

		// Guard de migración (una vez por vida del DO): asegura el esquema al día ANTES de aplicar
		// escrituras, por si se publicó un cambio de esquema con el tenant ya activo.
		await ensureTenantMigrated(dbTenant, tenantId);

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

	private async touchLastSeen(tenantId: string, deviceId: string, force = false) {
		// SYNC-08: sin throttle, cada ping (30 s) por dispositivo escribía en la BD central →
		// amplificación de escrituras proporcional al nº de dispositivos. Guardamos en memoria del
		// DO el último instante empujado y solo re-escribimos pasada la ventana (o si `force`, p. ej.
		// al conectar). La precisión de `last_seen` no necesita ser al segundo.
		// SYNC-16: el ping ya NO llega hasta aquí (lo contesta el auto-response sin despertar al DO),
		// así que ahora esto se alimenta de: conexión (force) y actividad real (apply/event). El
		// throttle en memoria se pierde al hibernar → como mucho un UPDATE extra por despertar.
		const now = nowMs();
		if (!force) {
			const last = this.lastSeenPushedAtMs.get(deviceId) ?? 0;
			if (now - last < LAST_SEEN_THROTTLE_MS) return;
		}
		this.lastSeenPushedAtMs.set(deviceId, now);
		const dbCentral = this.getCentralDb();
		await dbCentral.execute({
			sql: `UPDATE devices SET last_seen_at_ms=? WHERE tenant_id=? AND device_id=?`,
			args: [now, tenantId, deviceId],
		});
	}

	// SYNC-12: purga (throttled) del log de sync en el tenant. Solo borra filas por DEBAJO del
	// checkpoint mínimo de las Main activas (con holgura) Y suficientemente antiguas (TTL), de modo
	// que jamás retira un cambio que una Main aún no ha consumido. Best-effort: nunca rompe el sync.
	private async maybePurgeSyncLog(tenantId: string): Promise<void> {
		const now = nowMs();
		if (now - this.lastPurgeAtMs < PURGE_INTERVAL_MS) return;
		this.lastPurgeAtMs = now;
		try {
			await this.withTenantDbRetry(tenantId, async (db) => {
				// Suelo = mínimo Last_Seq de las Main que reportaron checkpoint recientemente. Si no
				// hay ninguna activa, MIN devuelve NULL → no purgamos Sync_Changes (fail-safe).
				const r = await db.execute({
					sql: `SELECT MIN(Last_Seq) AS floor FROM Sync_Main_Checkpoints WHERE Updated_At_Ms > ?1;`,
					args: [now - CHECKPOINT_ACTIVE_MS],
				});
				const floorRaw = (r.rows?.[0] as any)?.floor;
				const floor = floorRaw == null ? null : Number(floorRaw);

				if (floor != null && floor > PURGE_SEQ_MARGIN) {
					await db.execute({
						sql: `DELETE FROM Sync_Changes WHERE Seq <= ?1 AND Created_At_Ms < ?2;`,
						args: [floor - PURGE_SEQ_MARGIN, now - SYNC_CHANGES_TTL_MS],
					});
				}

				// Applied_Operations es dedup por Op_Id: un reintento idempotente nunca llega días
				// después, así que basta un TTL (independiente del checkpoint) para acotarla.
				await db.execute({
					sql: `DELETE FROM Applied_Operations WHERE Created_At_Ms < ?1;`,
					args: [now - APPLIED_OPS_TTL_MS],
				});
			});
		} catch {
			/* la purga es best-effort: nunca debe afectar al camino de escritura del sync */
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
		clientNow?: string | null;
	}): Promise<{ result: any; seq: number }> {
		const {
			tenantId,
			opId,
			commandName,
			deviceId,
			requestPayloadJson,
			cloudPayloadJson,
		} = params;

		// El tiempo lo fija el dispositivo emisor (cabecera X-Client-Now); resolvemos los
		// `datetime('now')` del comando a literal ANTES de ejecutar y de registrar el cambio,
		// para que la fila sea idéntica en nube, Main y Handy (replicación determinista).
		//
		// SYNC-04 (guard duro): si el comando lleva una forma `datetime('now',...)` SIN resolver y el
		// emisor NO mandó una X-Client-Now válida, RECHAZAMOS en vez de caer en silencio a UTC (lo que
		// dejaba la fila con zona horaria distinta al resto). Todo escritor legítimo pasa por el proxy
		// Rust `tpv_server_post_json`, que siempre fija la cabecera; este guard blinda contra cualquier
		// caller futuro que la omitiera. Los comandos ya-literales (p. ej. de la Main) no la exigen.
		const parsedNow = parseClientNow(params.clientNow);
		if (parsedNow === null && commandHasNowLiteral(params.cmd)) {
			throw new Error("missing_client_now");
		}
		const cmd = rewriteCmdNowLiterals(params.cmd, parsedNow ?? serverNowFixed());

		const op = opId.trim();
		const command = commandName.trim();

		if (!op) {
			throw new Error("missing_op_id");
		}

		if (!command) {
			throw new Error("missing_command_name");
		}

		// Freeze global: si no hay una Main (tpv) autenticada conectada, NO se
		// aplica nada. Vale tanto para escrituras REST de la Handy como para el
		// WS-write de la propia Main (que cuenta como presente al estar conectada).
		if (!this.isMainConnected()) {
			throw new Error("main_offline");
		}

		const requestHash = await sha256Hex(requestPayloadJson);
		const createdAtMs = nowMs();

		// Aplanamos el comando a un único batch atómico (1 round trip a Turso en lugar de ~7
		// awaits secuenciales de la transacción interactiva).
		const built = this.buildApplyBatch(cmd);

		const runApply = () => this.withTenantDbRetry(tenantId, async (db) => {
			// Batch atómico = [PRAGMA defer FK] + [gate idempotente] + [trabajo] + [log de sync].
			// El gate va SIN ON CONFLICT: en un reintento (mismo Op_Id) viola UNIQUE(Op_Id) y hace
			// rollback de TODO el batch → ni se duplica el trabajo ni el log. No existe estado
			// PROCESSING/FAILED intermedio: la op está APPLIED (commit) o ausente (rollback).
			const gate: ResolvedStmt = {
				sql: `INSERT INTO Applied_Operations (Op_Id, Command_Name, Request_Hash, Device_Id, Status, Result_Json, Error_Text, Created_At_Ms, Applied_At_Ms, Updated_At_Ms) VALUES (?1, ?2, ?3, ?4, 'APPLIED', ?5, NULL, ?6, ?6, ?6);`,
				args: [op, command, requestHash, deviceId || null, stringifyJsonValue(built.storageResult), createdAtMs],
			};
			const syncLog: ResolvedStmt = {
				sql: `INSERT INTO Sync_Changes (Op_Id, Command_Name, Statements_Json, Device_Id, Created_At_Ms) VALUES (?1, ?2, ?3, ?4, ?5);`,
				args: [op, command, stableStringify(built.replicated), deviceId || null, createdAtMs],
			};

			// Índices del batch: 0=PRAGMA, 1=gate, 2..=middle (trabajo+lecturas), último=syncLog.
			const MIDDLE_OFFSET = 2;
			const batchStmts: ResolvedStmt[] = [
				{ sql: "PRAGMA defer_foreign_keys = ON;", args: [] },
				gate,
				...built.middle,
				syncLog,
			];

			let batchResults: any[];
			try {
				batchResults = await db.batch(batchStmts as any, "write");
			} catch (e: any) {
				if (isUniqueOpIdViolation(e)) {
					// Reintento idempotente: la op ya estaba aplicada. Recuperamos result + seq.
					const recovered = await this.recoverAppliedOp(db, op, command, requestHash);
					// SYNC-03: si el DO se reinició/evictó tras el commit y ANTES del broadcast
					// original, las Handy (sin checkpoint) nunca recibieron el cambio. Al reintentar,
					// el emisor entra por este path idempotente: re-emitimos el broadcast para que el
					// resto de dispositivos converja. La Main secundaria lo descarta por Op_Id.
					if (recovered.statements.length) {
						this.broadcastChange(
							{
								command,
								opId: op,
								deviceId: deviceId || null,
								payloadJson: cloudPayloadJson,
								result: recovered.result,
								seq: recovered.seq,
								statements: recovered.statements,
							},
							deviceId || undefined,
						);
					}
					return { result: recovered.result, seq: recovered.seq };
				}
				throw e;
			}

			const seq = Number(batchResults[batchResults.length - 1]?.lastInsertRowid ?? 0);
			const result = built.resolveResult(batchResults, MIDDLE_OFFSET);

			// SYNC-10: el gate guardó un Result_Json best-effort (solo literales; lo derivado de la
				// DB quedó null). Si el resultado REAL difiere (incluye campos derivados de la DB), lo
				// persistimos ahora para que un reintento idempotente (p. ej. una Handy con
				// timeout+retry) devuelva el MISMO `data` que el primer intento, no uno degradado.
				// Solo pagamos el round trip extra cuando de verdad hay algo que refinar.
				const realResultJson = stringifyJsonValue(result);
				if (realResultJson !== stringifyJsonValue(built.storageResult)) {
					try {
						await db.execute({
							sql: "UPDATE Applied_Operations SET Result_Json = ?1, Updated_At_Ms = ?2 WHERE Op_Id = ?3;",
							args: [realResultJson, nowMs(), op],
						});
					} catch {
						/* refinar el cache es best-effort: nunca romper el apply por esto */
					}
				}

				// Tras confirmar en Turso, propagamos el cambio (payload + resultado) al resto de
			// dispositivos autenticados. El originador queda excluido. La Main aplica el payload
			// directo a su SQLite local (no hay refetch).
			this.broadcastChange(
				{
					command,
					opId: op,
					deviceId: deviceId || null,
					payloadJson: cloudPayloadJson,
					result,
					seq,
					statements: built.replicated,
				},
				deviceId || undefined,
			);

			// SYNC-12: aprovechamos una escritura confirmada para purgar (throttled, fire-and-forget)
				// el log de sync ya consumido por todas las Main. No bloquea el apply.
				this.state.waitUntil(this.maybePurgeSyncLog(tenantId));

				// OBS-04: en el ÉXITO no emitimos nada a Axiom. El coste que disparaba el volumen era
			// justo este evento por cada `apply`; el detalle de un apply correcto no se necesita.
			return { result, seq };
		});

		try {
			return await runApply();
		} catch (e: any) {
			// Sólo los FALLOS van a Axiom (100%), con payload RECORTADO: nombre de comando + ids +
			// error truncado. NO incluimos el comando ni sus args (evita filtrar datos y volumen).
			// El freeze `main_offline` no llega aquí (se lanza antes) y ya tiene su propio evento.
			this.emitSyncEvent("apply_error", {
				command_name: command,
				op_id: op,
				device_id: deviceId || null,
				tenant_id: tenantId,
				error: String(e?.message || e).slice(0, 500),
				latency_ms: nowMs() - createdAtMs,
			});
			throw e;
		}
	}

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
	private buildApplyBatch(cmd: InternalApplyCommand): {
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

	// Reintento idempotente: la op ya existe (violación UNIQUE en el gate). Recuperamos el
	// resultado cacheado y el `seq` del log, validando que no haya mismatch de comando/payload.
	private async recoverAppliedOp(
		db: any,
		op: string,
		command: string,
		requestHash: string,
	): Promise<{ result: any; seq: number; statements: ResolvedStmt[] }> {
		const r = await db.execute({
			sql: `SELECT Command_Name AS command_name, Request_Hash AS request_hash, Result_Json AS result_json FROM Applied_Operations WHERE Op_Id = ?1 LIMIT 1;`,
			args: [op],
		});
		const row = r.rows?.[0] as any | undefined;
		if (!row) throw new Error("idempotency_operation_processing");
		if (String(row.command_name || "") !== command) throw new Error("idempotency_command_mismatch");
		if (String(row.request_hash || "") !== requestHash) throw new Error("idempotency_payload_mismatch");
		const result = safeJsonParse(String(row.result_json ?? "null"));
		const { seq, statements } = await this.lookupChange(db, op);
		return { result, seq, statements };
	}

	// Recupera el `Seq` y las sentencias replicadas que el log de cambios asignó a una op ya
	// aplicada (reintentos idempotentes). Las sentencias permiten re-emitir el broadcast (SYNC-03).
	// Devuelve `{ seq: 0, statements: [] }` si no hay registro.
	private async lookupChange(
		executor: any,
		opId: string,
	): Promise<{ seq: number; statements: ResolvedStmt[] }> {
		try {
			const r = await executor.execute({
				sql: "SELECT Seq AS seq, Statements_Json AS statements_json FROM Sync_Changes WHERE Op_Id = ?1 ORDER BY Seq DESC LIMIT 1;",
				args: [opId],
			});
			const row = r.rows?.[0] as any | undefined;
			const seq = Number(row?.seq ?? 0);
			const parsed = safeJsonParse(String(row?.statements_json ?? "[]"));
			const statements: ResolvedStmt[] = Array.isArray(parsed) ? parsed : [];
			return { seq, statements };
		} catch {
			return { seq: 0, statements: [] };
		}
	}

	/**
	 * Emite un evento de SALUD del sistema de sincronización a Axiom (dataset AXIOM_DATASET_SYNC).
	 * Fire-and-forget: la observabilidad jamás debe afectar al camino de escritura del sync, así que
	 * no se espera ni se propagan errores. No-op si Axiom no está configurado.
	 */
	private emitSyncEvent(name: string, fields: Record<string, unknown>): void {
		const dataset = this.env.AXIOM_DATASET_SYNC;
		if (!this.env.AXIOM_TOKEN || !dataset) return;
		try {
			const event = {
				_time: new Date().toISOString(),
				service: "tpv-sync",
				event: name,
				tenant_id: this.tenantDbTenantId ?? undefined,
				connected_devices: this.authedCount(),
				main_connected: this.isMainConnected(),
				...fields,
			};
			void ingestToAxiom(this.env, dataset, [event]);
		} catch {
			/* la salud de sync es best-effort; nunca afecta al sync */
		}
	}

	private send(ws: WebSocket, obj: any) {
		try {
			ws.send(JSON.stringify(obj));
		} catch { }
	}

	private broadcast(obj: any, exceptDeviceId?: string) {
		const msg = JSON.stringify(obj);
		for (const ws of this.state.getWebSockets()) {
			const a = this.att(ws);
			if (!a) continue;
			if (exceptDeviceId && a.deviceId === exceptDeviceId) continue;
			try {
				ws.send(msg);
			} catch { }
		}
	}

	private broadcastAuthed(obj: any, exceptDeviceId?: string) {
		const msg = JSON.stringify(obj);

		for (const ws of this.state.getWebSockets()) {
			const a = this.att(ws);
			if (!a || !a.authed) continue;
			if (exceptDeviceId && a.deviceId === exceptDeviceId) continue;

			try {
				ws.send(msg);
			} catch { }
		}
	}

	// ¿Hay alguna Main (rol tpv) autenticada y conectada ahora mismo?
	// `except` excluye un socket concreto: al procesar `webSocketClose` el socket que se va puede
	// seguir apareciendo en `getWebSockets()`, y sin excluirlo nunca detectaríamos el freeze.
	private isMainConnected(except?: WebSocket): boolean {
		for (const ws of this.state.getWebSockets()) {
			if (except && ws === except) continue;
			const a = this.att(ws);
			if (a?.authed && a.role === "tpv") return true;
		}
		return false;
	}

	/** Nº de dispositivos autenticados ahora mismo (telemetría). */
	private authedCount(): number {
		let n = 0;
		for (const ws of this.state.getWebSockets()) {
			if (this.att(ws)?.authed) n++;
		}
		return n;
	}

	// Propaga un cambio aplicado (payload + resultado) a los dispositivos
	// autenticados, excluyendo al originador. Reemplaza la antigua señal
	// `cloud_changes_available` (modelo de refetch) por el envío directo del JSON.
	private broadcastChange(
		params: {
			command: string;
			opId: string;
			deviceId: string | null;
			payloadJson: string;
			result: any;
			seq: number;
			statements: ResolvedStmt[];
		},
		exceptDeviceId?: string,
	) {
		this.broadcastAuthed(
			{
				type: "change",
				command: params.command,
				opId: params.opId,
				deviceId: params.deviceId,
				payload: safeJsonParse(params.payloadJson),
				result: params.result ?? null,
				// Opción 3: sentencias ya resueltas + cursor, para que la Main las aplique
				// directamente a su SQLite local (y sepa su checkpoint).
				seq: params.seq,
				statements: params.statements,
				ts: nowMs(),
			},
			exceptDeviceId,
		);
	}

	// SYNC-16: ya no se guarda en un Map del DO; el llamante lo adosa al socket (attachment) para
	// que sobreviva a la hibernación.
	private issueChallenge(): { nonceB64: string; expiresAtMs: number } {
		const nonce = new Uint8Array(32);
		crypto.getRandomValues(nonce);
		const nonceB64 = bytesToB64(nonce);

		const expiresAtMs = nowMs() + 60_000;

		return { nonceB64, expiresAtMs };
	}

	// SYNC-16: el challenge y la pista de pubkey llegan desde el attachment del socket (el llamante
	// ya ha consumido el challenge antes de invocarnos) y devolvemos la pubkey confirmada para que
	// el llamante la persista de vuelta en el attachment.
	private async verifyHelloSigned(params: {
		tenantId: string;
		deviceId: string;
		msg: HelloSignedMsg;
		challenge: { nonceB64: string; expiresAtMs: number } | null;
		pubkeyB64Hint?: string | null;
	}): Promise<{ roleFinal: Role; pubkeyB64: string }> {
		const { tenantId, deviceId, msg, challenge: ch, pubkeyB64Hint } = params;

		if (!ch) throw new Error("missing_challenge");
		if (msg.nonceB64 !== ch.nonceB64) throw new Error("challenge_mismatch");
		if (nowMs() > ch.expiresAtMs) throw new Error("challenge_expired");

		const MAX_SKEW_MS = 2 * 60 * 1000;
		if (!Number.isFinite(msg.ts)) throw new Error("bad_ts");
		if (Math.abs(nowMs() - msg.ts) > MAX_SKEW_MS) {
			throw new Error("ts_out_of_range");
		}

		let pubkeyB64 = (pubkeyB64Hint || "").trim();

		const centralInfo = await this.loadDeviceFromCentral(tenantId, deviceId);
		if (centralInfo.revoked) throw new Error("device_revoked");
		if (centralInfo.pubkeyB64) pubkeyB64 = centralInfo.pubkeyB64;

		// El rol lo dicta EXCLUSIVAMENTE la BD central (activación → 'tpv',
		// pairing → 'handy'). La cabecera x-role es del cliente y no puede
		// otorgar privilegios: si la fila no trae un rol válido, el dispositivo
		// queda "unknown" (sin permisos de apply ni de eventos).
		const roleFinal: Role = centralInfo.role;

		if (!pubkeyB64) throw new Error("device_pubkey_not_registered");

		const payload = new TextEncoder().encode(
			`${msg.ts}\nWS_HELLO\n${tenantId}\n${deviceId}\n${msg.nonceB64}`,
		);

		const pub = nobleForceU8(b64ToBytes(pubkeyB64));
		const sig = nobleForceU8(b64ToBytes(msg.sigB64));

		const ok = await ed25519Verify(sig, payload, pub);
		if (!ok) throw new Error("bad_ws_signature");

		return { roleFinal, pubkeyB64 };
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/internal/revoke" && request.method === "POST") {
			const body = safeJsonParse(await request.text()) || {};
			const deviceId = String(body.deviceId || "").trim();

			// SYNC-16: no hay estado que limpiar a mano (el attachment muere con el socket). Pero el
			// cierre lo inicia el SERVIDOR, y Cloudflare no garantiza que eso dispare
			// `webSocketClose`, así que hacemos la contabilidad de presencia/freeze explícitamente:
			// revocar la Main debe congelar las Handy igual que si se hubiera caído.
			if (deviceId) {
				for (const ws of this.liveSocketsFor(deviceId)) {
					const a = this.att(ws);
					try {
						ws.close(4001, "revoked");
					} catch { }
					if (a) this.sessionGone(ws, a);
				}
			}

			return new Response("OK", { status: 200 });
		}

		if (url.pathname === "/internal/apply" && request.method === "POST") {
			const raw = await request.text();

			// Sólo el worker `tpv-api` legítimo (que conoce LICENSE_JWT_SECRET) puede
			// aplicar SQL en el tenant. Sin esto, cualquiera que alcanzase el DO con los
			// headers correctos podría escribir comandos arbitrarios.
			try {
				await verifyInternalWorkerRequest(
					request,
					String(this.env.LICENSE_JWT_SECRET || ""),
					raw,
				);
			} catch (e: any) {
				return jsonResponse({ ok: false, error: String(e?.message || e) }, 401);
			}

			const tenantId = String(request.headers.get("x-tenant-id") || "").trim();
			if (!tenantId) {
				return jsonResponse({ ok: false, error: "missing_tenant_id" }, 400);
			}

			const body = safeJsonParse(raw) || {};
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

			const clientNow = String(
				request.headers.get("x-client-now") ||
				getFirstOwnValue(body, ["client_now", "clientNow"]) ||
				"",
			);

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
				const { result } = await this.applyInternalCommandIdempotent({
					tenantId,
					cmd,
					opId,
					commandName,
					deviceId,
					requestPayloadJson,
					cloudPayloadJson,
					clientNow,
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

		// SYNC-16: `acceptWebSocket` (en vez de `server.accept()`) entrega el socket al runtime, que
		// puede entonces evacuar el DO de memoria mientras la conexión está ociosa SIN cerrarla. La
		// etiqueta `deviceId` sustituye al antiguo `Map<deviceId, WebSocket>` → `getWebSockets(id)`.
		this.state.acceptWebSocket(server, [deviceId]);

		const ch = this.issueChallenge();

		// Todo el estado de la sesión va adosado al socket: sobrevive a la hibernación.
		this.setAtt(server, {
			tenantId,
			deviceId,
			role: roleHeader,
			authed: false,
			pubkeyB64: pubkeyHint,
			challenge: ch,
		});

		// Reconexión con el mismo deviceId: se echa la sesión anterior. Se cierra DESPUÉS de aceptar
		// la nueva para que su `webSocketClose` vea que ya hay un socket vivo y no dispare el freeze.
		for (const prev of this.liveSocketsFor(deviceId, server)) {
			try {
				prev.close(4000, "replaced");
			} catch { }
		}

		this.state.waitUntil(this.touchLastSeen(tenantId, deviceId, true));

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

		return new Response(null, { status: 101, webSocket: client });
	}

	// ---- SYNC-16: handlers de la Hibernation API --------------------------------------------
	// Sustituyen a los antiguos `server.addEventListener(...)`. Al despertar de la hibernación la
	// instancia es NUEVA (campos vacíos, sin closures), así que el runtime invoca estos métodos y
	// todo el contexto de la sesión se recupera del attachment del socket.

	async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
		const a = this.att(ws);
		if (!a) {
			// Socket sin attachment: no sabemos ni quién es. No debería ocurrir.
			this.send(ws, { type: "error", error: "no_session" });
			return;
		}
		const { tenantId, deviceId } = a;

		const data = typeof message === "string" ? message : "";
		const msg = safeJsonParse(data) as AnyMsg | null;

		if (!msg || typeof msg.type !== "string") {
			this.send(ws, { type: "error", error: "bad_json" });
			return;
		}

		// El latido normal lo contesta el auto-response SIN despertar al DO (constructor), así que
		// aquí sólo caen pings con otra serialización. Se responde igual por compatibilidad.
		if (msg.type === "ping") {
			this.send(ws, { type: "pong", ts: nowMs() });
			return;
		}

		if (msg.type === "helloSigned") {
			// SYNC-07: challenge de un SOLO uso. Se consume AQUÍ, de forma síncrona y antes de
			// cualquier `await`, para que dos helloSigned seguidos no puedan reutilizar el nonce.
			const challenge = a.challenge;
			this.setAtt(ws, { ...a, challenge: null });

			this.state.waitUntil(
				(async () => {
					try {
						const { roleFinal, pubkeyB64 } = await this.verifyHelloSigned({
							tenantId,
							deviceId,
							msg,
							challenge,
							pubkeyB64Hint: a.pubkeyB64,
						});

						// Persistimos el resultado de la autenticación en el attachment: es lo que
						// leerán los futuros mensajes, broadcasts y el cierre (incluso tras hibernar).
						this.setAtt(ws, {
							...a,
							role: roleFinal,
							authed: true,
							pubkeyB64,
							challenge: null,
						});

						this.send(ws, {
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

						// Freeze por presencia de Main: informamos a este
						// dispositivo de si hay Main conectada (una Handy recién
						// autenticada necesita saberlo para bloquear/desbloquear su
						// UI). Y si quien se autentica ES la Main, avisamos a las
						// Handy de que ya pueden operar.
						this.send(ws, {
							type: "main_status",
							online: this.isMainConnected(),
						});

						if (roleFinal === "tpv") {
							this.broadcast({ type: "main_online", deviceId }, deviceId);
							this.emitSyncEvent("main_online", { device_id: deviceId });
						}
					} catch (e: any) {
						const err = String(e?.message || e);
						this.send(ws, {
							type: "error",
							error: "hello_failed",
							details: err,
						});
						try {
							ws.close(4003, "auth_failed");
						} catch { }
					}
				})(),
			);
			return;
		}

		if (!a.authed) {
			this.send(ws, { type: "error", error: "not_authenticated" });
			return;
		}

		// Actividad real del dispositivo (ya no hay pings que la reflejen): refrescamos `last_seen`
		// de forma throttleada y fire-and-forget.
		this.state.waitUntil(this.touchLastSeen(tenantId, deviceId));

		// Escritura de la Main por WS: se aplica al MISMO motor idempotente que
		// las escrituras REST de la Handy (commit en Turso + broadcast del cambio
		// al resto). La Main no se bloquea esperando; recibe un `apply_ack`
		// asíncrono solo para reconciliar/revertir si algo falla.
		if (msg.type === "apply") {
			const m = msg as ApplyMsg;

			// Autorización por rol: solo la Main (`tpv`) puede ejecutar SQL crudo
			// por WS. El rol viene del helloSigned (BD central), nunca de la
			// cabecera x-role del cliente. Las escrituras de la Handy van por
			// REST → comandos de dominio acotados (hub.ts → /internal/apply).
			if (a.role !== "tpv") {
				this.send(ws, {
					type: "apply_ack",
					opId: String(m.opId ?? m.op_id ?? "").trim(),
					ok: false,
					error: "forbidden_not_tpv",
				});
				return;
			}

			const inner = m.command;
			const cmdType = String(inner?.type || "").trim();
			const opId = String(m.opId ?? m.op_id ?? "").trim();
			const commandName = String(m.commandName ?? m.command_name ?? "").trim();

			if (!cmdType || !opId || !commandName) {
				this.send(ws, {
					type: "apply_ack",
					opId,
					ok: false,
					error: "missing_apply_fields",
				});
				return;
			}

			const cmd = {
				type: inner!.type,
				payload: inner!.payload,
			} as InternalApplyCommand;

			const fallback = buildInternalPayloadForHash(cmd);
			const requestPayloadJson = readRequestPayloadJson(m, fallback);
			const cloudPayloadJson = readCloudPayloadJson({
				body: m,
				opId,
				commandName,
				fallbackPayloadForHash: fallback,
			});
			// La Main ya manda sus sentencias con el tiempo resuelto a literal; aun así
			// honramos un X-Client-Now si viniera (no hace daño: el rewrite es no-op).
			const clientNow = String(
				getFirstOwnValue(m, ["client_now", "clientNow"]) || "",
			);

			this.state.waitUntil(
				(async () => {
					try {
						const { result, seq } = await this.applyInternalCommandIdempotent({
							tenantId,
							cmd,
							opId,
							commandName,
							deviceId,
							requestPayloadJson,
							cloudPayloadJson,
							clientNow,
						});
						this.send(ws, {
							type: "apply_ack",
							opId,
							ok: true,
							result,
							// `seq` que la nube asignó a la op: la Main asciende su anti-eco con él.
							seq,
						});
					} catch (e: any) {
						this.send(ws, {
							type: "apply_ack",
							opId,
							ok: false,
							error: String(e?.message || e),
						});
					}
				})(),
			);
			return;
		}

		if (msg.type === "event") {
			// El rol para autorizar viene del helloSigned (BD central); la
			// cabecera x-role del cliente jamás decide permisos.
			const role = a.role ?? "unknown";
			const name = String(msg.name || "");

			if (!isEventAllowed(role, name)) {
				this.send(ws, {
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
							this.send(ws, { type: "event_ack", name, ok: true });
						} catch (e: any) {
							this.send(ws, {
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

		this.send(ws, { type: "error", error: "unknown_type" });
	}

	/**
	 * Contabilidad de una sesión que se va: presencia + freeze. Se invoca desde `webSocketClose`
	 * (cierre del cliente / caída de red) y TAMBIÉN de forma explícita en los cierres que inicia el
	 * servidor (revoke), porque la documentación de Cloudflare no garantiza que `webSocketClose` se
	 * dispare cuando el cierre lo provoca el propio DO. Es **idempotente y auto-inhibida**: si queda
	 * otro socket vivo del mismo dispositivo no hace nada, y repetirla solo reemite señales que el
	 * cliente ya trata como idempotentes.
	 */
	private sessionGone(ws: WebSocket, a: WsAttachment): void {
		const { deviceId } = a;

		// Si ya nos reemplazó una reconexión bajo el mismo deviceId, no dispares presencia ni
		// main_offline en falso: la sesión nueva sigue viva.
		if (this.liveSocketsFor(deviceId, ws).length > 0) return;

		const wasMain = a.role === "tpv";

		this.lastSeenPushedAtMs.delete(deviceId);
		this.broadcast({ type: "presence", action: "leave", deviceId }, deviceId);

		// Si se va la Main y no queda ninguna conectada, congelamos todo: las
		// Handy reciben main_offline y deben bloquear su UI hasta que vuelva.
		// `ws` se excluye explícitamente del censo: un socket cerrándose puede seguir apareciendo
		// en `getWebSockets()` y nos haría creer que la Main sigue ahí.
		if (wasMain && !this.isMainConnected(ws)) {
			this.broadcast({ type: "main_offline", deviceId }, deviceId);
			this.emitSyncEvent("main_offline", { device_id: deviceId });
		}
	}

	async webSocketClose(
		ws: WebSocket,
		_code: number,
		_reason: string,
		_wasClean: boolean,
	): Promise<void> {
		const a = this.att(ws);
		if (!a) return;
		this.sessionGone(ws, a);
	}

	async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
		const a = this.att(ws);
		try {
			ws.close(1011, "ws_error");
		} catch { }
		// Cierre iniciado por el servidor → contabilizamos la salida nosotros (ver `sessionGone`).
		if (a) this.sessionGone(ws, a);
	}
}