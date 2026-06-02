export type SqlScalar = string | number | boolean | null;
export type SqlRef = { $ref: string };
export type SqlArg = SqlScalar | SqlRef;

export type ExecPayload = {
	sql: string;
	args?: SqlArg[];
};

export type QueryPayload = {
	sql: string;
	args?: SqlArg[];
};

export type TxStep =
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

export type TransactionPayload = {
	steps: TxStep[];
	resultKey?: string;
	beginMode?: "deferred" | "immediate" | "exclusive";
};

export type InternalApplyCommand =
	| { type: "tenantDb.ping" }
	| { type: "tenantDb.exec"; payload: ExecPayload }
	| { type: "tenantDb.value"; payload: QueryPayload }
	| { type: "tenantDb.row"; payload: QueryPayload }
	| { type: "tenantDb.rows"; payload: QueryPayload }
	| { type: "tenantDb.transaction"; payload: TransactionPayload };

export type CommandCloudPayload<TArgs = any> = {
	op_id: string;
	command_name: string;
	args: TArgs;
};

type TenantHubApplyEnvelope = {
	ok?: boolean;
	error?: string;
	data?: unknown;
	result?: unknown;
};

type ApplyTenantHubBaseParams = {
	env: any;
	tenantId: string;
	opId: string;
	commandName: string;
	deviceId?: string | null;

	/**
	 * Payload de dominio que se guardará en Cloud_Changes.Payload_Json.
	 *
	 * Este payload es el que luego entiende la app local en cloud_sync.rs:
	 * {
	 *   op_id,
	 *   command_name,
	 *   args
	 * }
	 */
	cloudPayload?: unknown;
	cloudPayloadJson?: string | null;

	/**
	 * Payload usado para calcular Request_Hash en Applied_Operations.
	 *
	 * Si no se pasa, TenantHub usará cloudPayload como fallback.
	 * Si tampoco existe cloudPayload, usará el payload interno SQL/transaction.
	 */
	requestPayload?: unknown;
	requestPayloadJson?: string | null;
};

export type ReadWriteRequestResult<T> = {
	rawBody: any;
	input: T;
	opId: string;
	commandName: string;
};

export async function readJsonSafe<T>(req: Request, fallback: T): Promise<T> {
	try {
		return (await req.json()) as T;
	} catch {
		return fallback;
	}
}

export function unwrapArgs<T>(body: any): T {
	if (body && typeof body === "object") {
		if (body.args && typeof body.args === "object") return body.args as T;
		if (body.payload && typeof body.payload === "object") return body.payload as T;
		if (body.input && typeof body.input === "object") return body.input as T;
	}

	return (body ?? {}) as T;
}

export function safeJsonParse<T = any>(text: string): T | null {
	try {
		return JSON.parse(text) as T;
	} catch {
		return null;
	}
}

export function sqlRef(name: string): SqlRef {
	return { $ref: name };
}

export function getTenantIdFromContext(ctx: any): string {
	return String(
		ctx?.claims?.tenantId ??
		ctx?.tenantId ??
		ctx?.tenant_id ??
		ctx?.tenant?.id ??
		ctx?.tenant?.tenantId ??
		ctx?.license?.tenantId ??
		ctx?.license?.tenant_id ??
		"",
	).trim();
}

export function getDeviceIdFromContext(ctx: any): string | null {
	const deviceId = String(
		ctx?.claims?.deviceId ??
		ctx?.deviceId ??
		ctx?.device_id ??
		ctx?.tenant?.deviceId ??
		ctx?.license?.deviceId ??
		"",
	).trim();

	return deviceId || null;
}

export function getOpIdFromBody(rawBody: any, input?: any): string {
	const sources = [input, rawBody];

	for (const source of sources) {
		if (!source || typeof source !== "object") continue;

		const value =
			source.opId ??
			source.op_id ??
			source.payload?.opId ??
			source.payload?.op_id ??
			source.input?.opId ??
			source.input?.op_id ??
			null;

		const opId = String(value ?? "").trim();
		if (opId) return opId;
	}

	return "";
}

export function getCommandNameFromBody(rawBody: any, input?: any): string {
	const sources = [input, rawBody];

	for (const source of sources) {
		if (!source || typeof source !== "object") continue;

		const value =
			source.commandName ??
			source.command_name ??
			source.payload?.commandName ??
			source.payload?.command_name ??
			source.input?.commandName ??
			source.input?.command_name ??
			null;

		const commandName = String(value ?? "").trim();
		if (commandName) return commandName;
	}

	return "";
}

export function getOpIdFromHeaders(req: Request): string {
	return String(
		req.headers.get("X-Idempotency-Key") ??
		req.headers.get("x-idempotency-key") ??
		"",
	).trim();
}

export function getCommandNameFromHeaders(req: Request): string {
	return String(
		req.headers.get("X-Command-Name") ??
		req.headers.get("x-command-name") ??
		"",
	).trim();
}

export function getOpId(req: Request, rawBody: any, input?: any): string {
	return getOpIdFromBody(rawBody, input) || getOpIdFromHeaders(req);
}

export function getCommandName(req: Request, rawBody: any, input?: any): string {
	return getCommandNameFromBody(rawBody, input) || getCommandNameFromHeaders(req);
}

export function deriveChildOpId(opId: string, suffix: string): string {
	const base = String(opId || "").trim();
	const safeSuffix = String(suffix || "child").replace(/[^a-zA-Z0-9_.:-]/g, "_");

	if (!base) {
		throw new Error("missing_parent_op_id");
	}

	return `${base}:${safeSuffix}`;
}

export function buildCommandCloudPayload<TArgs>(params: {
	opId: string;
	commandName: string;
	args: TArgs;
}): CommandCloudPayload<TArgs> {
	const opId = String(params.opId || "").trim();
	const commandName = String(params.commandName || "").trim();

	if (!opId) {
		throw new Error("missing_op_id");
	}

	if (!commandName) {
		throw new Error("missing_command_name");
	}

	return {
		op_id: opId,
		command_name: commandName,
		args: params.args,
	};
}

export async function readWriteRequest<T>(
	req: Request,
	fallback: T,
): Promise<ReadWriteRequestResult<T>> {
	const rawBody = await readJsonSafe(req, fallback);
	const input = unwrapArgs<T>(rawBody);
	const opId = getOpId(req, rawBody, input);
	const commandName = getCommandName(req, rawBody, input);

	return {
		rawBody,
		input,
		opId,
		commandName,
	};
}

export function getTenantHubNamespace(env: any): any {
	return env?.TENANT_HUB ?? env?.TenantHub ?? null;
}

function getTenantHubStub(env: any, tenantId: string): any {
	const tenantHub = getTenantHubNamespace(env);
	if (!tenantHub) {
		throw new Error("missing_tenant_hub_binding");
	}

	if (typeof tenantHub.getByName === "function") {
		return tenantHub.getByName(tenantId);
	}

	if (
		typeof tenantHub.idFromName === "function" &&
		typeof tenantHub.get === "function"
	) {
		return tenantHub.get(tenantHub.idFromName(tenantId));
	}

	throw new Error("invalid_tenant_hub_binding");
}

function assertWriteMetadata(
	tenantId: string,
	opId: string,
	commandName: string,
): void {
	if (!String(tenantId || "").trim()) {
		throw new Error("missing_tenant_id");
	}

	if (!String(opId || "").trim()) {
		throw new Error("missing_op_id");
	}

	if (!String(commandName || "").trim()) {
		throw new Error("missing_command_name");
	}
}

function optionalStringValue(value: unknown): string | undefined {
	const out = String(value ?? "").trim();
	return out || undefined;
}

export async function applyTenantHubCommand<T>(
	params: ApplyTenantHubBaseParams & InternalApplyCommand,
): Promise<T> {
	const {
		env,
		tenantId,
		opId,
		commandName,
		deviceId,
		cloudPayload,
		cloudPayloadJson,
		requestPayload,
		requestPayloadJson,
		...command
	} = params;

	assertWriteMetadata(tenantId, opId, commandName);

	const stub = getTenantHubStub(env, tenantId);

	const body: Record<string, any> = {
		...command,

		// Formato canónico nuevo.
		op_id: opId,
		command_name: commandName,
		device_id: deviceId || undefined,

		// Compatibilidad con código existente.
		opId,
		commandName,
		deviceId: deviceId || undefined,
	};

	if (cloudPayload !== undefined) {
		body.cloud_payload = cloudPayload;
		body.cloudPayload = cloudPayload;
	}

	const cloudPayloadJsonValue = optionalStringValue(cloudPayloadJson);
	if (cloudPayloadJsonValue) {
		body.cloud_payload_json = cloudPayloadJsonValue;
		body.cloudPayloadJson = cloudPayloadJsonValue;
	}

	if (requestPayload !== undefined) {
		body.request_payload = requestPayload;
		body.requestPayload = requestPayload;
	}

	const requestPayloadJsonValue = optionalStringValue(requestPayloadJson);
	if (requestPayloadJsonValue) {
		body.request_payload_json = requestPayloadJsonValue;
		body.requestPayloadJson = requestPayloadJsonValue;
	}

	const response = await stub.fetch("https://tenant-hub/internal/apply", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-tenant-id": tenantId,
		},
		body: JSON.stringify(body),
	});

	const text = await response.text();
	const data = safeJsonParse<TenantHubApplyEnvelope>(text);

	if (!response.ok) {
		throw new Error(String(data?.error || `tenant_hub_http_${response.status}`));
	}

	if (!data || data.ok !== true) {
		throw new Error(String(data?.error || "tenant_hub_apply_failed"));
	}

	return (data.data ?? data.result ?? data) as T;
}

export async function applyTenantHubExec<T = unknown>(
	params: ApplyTenantHubBaseParams & ExecPayload,
): Promise<T> {
	const { sql, args = [], ...rest } = params;

	return await applyTenantHubCommand<T>({
		...rest,
		type: "tenantDb.exec",
		payload: { sql, args },
	});
}

export async function applyTenantHubValue<T = unknown>(
	params: ApplyTenantHubBaseParams & QueryPayload,
): Promise<T> {
	const { sql, args = [], ...rest } = params;

	return await applyTenantHubCommand<T>({
		...rest,
		type: "tenantDb.value",
		payload: { sql, args },
	});
}

export async function applyTenantHubRow<T = unknown>(
	params: ApplyTenantHubBaseParams & QueryPayload,
): Promise<T> {
	const { sql, args = [], ...rest } = params;

	return await applyTenantHubCommand<T>({
		...rest,
		type: "tenantDb.row",
		payload: { sql, args },
	});
}

export async function applyTenantHubRows<T = unknown>(
	params: ApplyTenantHubBaseParams & QueryPayload,
): Promise<T> {
	const { sql, args = [], ...rest } = params;

	return await applyTenantHubCommand<T>({
		...rest,
		type: "tenantDb.rows",
		payload: { sql, args },
	});
}

export async function applyTenantHubTransaction<T = unknown>(
	params: ApplyTenantHubBaseParams & TransactionPayload,
): Promise<T> {
	const { steps, resultKey, beginMode, ...rest } = params;

	return await applyTenantHubCommand<T>({
		...rest,
		type: "tenantDb.transaction",
		payload: {
			steps,
			resultKey,
			beginMode,
		},
	});
}