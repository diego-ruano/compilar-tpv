import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../middleware/withTenant";
import { createDbClient } from "../../../db/clients";
import { json, unauthorized, serverError } from "../../../utils/response";
import { getTenantIdFromContext } from "../../../utils/tenantHubWrites";

type SyncChangesInput = {
	afterId?: number;
	after_id?: number;
	afterChangeId?: number;
	after_change_id?: number;
	limit?: number;
};

function readNumber(value: any, fallback: number): number {
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}

async function readJsonSafe<T>(req: Request, fallback: T): Promise<T> {
	try {
		return (await req.json()) as T;
	} catch {
		return fallback;
	}
}

function isAuthError(msg: string): boolean {
	return (
		msg.includes("missing_token") ||
		msg.includes("invalid_token") ||
		msg.includes("invalid_token_claims") ||
		msg.includes("missing_device_proof") ||
		msg.includes("bad_device_signature") ||
		msg.includes("device_ts_out_of_range") ||
		msg.includes("device_pubkey_not_registered") ||
		msg.includes("bad_device_ts") ||
		msg.includes("bad_b64") ||
		msg.includes("device_not_registered") ||
		msg.includes("device_revoked") ||
		msg.includes("forbidden")
	);
}

function isMissingCloudChangesTable(msg: string): boolean {
	const m = msg.toLowerCase();
	return m.includes("no such table") && m.includes("cloud_changes");
}

function isMissingCommandVersionColumn(msg: string): boolean {
	const m = msg.toLowerCase();
	return m.includes("no such column") && m.includes("command_version");
}

function mapChangeRow(row: any) {
	const deviceId =
		row.Device_Id !== undefined
			? row.Device_Id
			: row.device_id !== undefined
				? row.device_id
				: row[4] ?? null;

	const resultJson =
		row.Result_Json !== undefined
			? row.Result_Json
			: row.result_json !== undefined
				? row.result_json
				: row[6] ?? null;

	return {
		idChange: Number(row.ID_Change ?? row.id_change ?? row[0] ?? 0),
		opId: String(row.Op_Id ?? row.op_id ?? row[1] ?? ""),
		commandName: String(row.Command_Name ?? row.command_name ?? row[2] ?? ""),
		commandVersion: Number(row.Command_Version ?? row.command_version ?? row[3] ?? 1),
		deviceId: deviceId == null ? null : String(deviceId),
		payloadJson: String(row.Payload_Json ?? row.payload_json ?? row[5] ?? "null"),
		resultJson: resultJson == null ? null : String(resultJson),
		createdAtMs: Number(row.Created_At_Ms ?? row.created_at_ms ?? row[7] ?? 0),
	};
}

function emptySyncResponse(afterChangeId: number, req: Request): Response {
	return json(
		{
			ok: true,

			// Compatibilidad con cloudSync.ts actual
			items: [],
			changes: [],

			lastChangeId: afterChangeId,
			nextAfterId: afterChangeId,
			hasMore: false,
			serverTimeMs: Date.now(),

			// Formato estándar futuro
			data: {
				items: [],
				changes: [],
				lastChangeId: afterChangeId,
				nextAfterId: afterChangeId,
				hasMore: false,
				serverTimeMs: Date.now(),
			},
		},
		200,
		req,
	);
}

async function queryCloudChanges(params: {
	db: Client;
	afterChangeId: number;
	limit: number;
}): Promise<any[]> {
	const { db, afterChangeId, limit } = params;

	try {
		const r = await db.execute({
			sql: `
				SELECT
					ID_Change,
					Op_Id,
					Command_Name,
					Command_Version,
					Device_Id,
					Payload_Json,
					Result_Json,
					Created_At_Ms
				FROM Cloud_Changes
				WHERE ID_Change > ?1
				ORDER BY ID_Change ASC
				LIMIT ?2;
			`,
			args: [afterChangeId, limit + 1],
		});

		return r.rows ?? [];
	} catch (e: any) {
		const msg = String(e?.message || e);

		if (isMissingCommandVersionColumn(msg)) {
			const r = await db.execute({
				sql: `
					SELECT
						ID_Change,
						Op_Id,
						Command_Name,
						1 AS Command_Version,
						Device_Id,
						Payload_Json,
						Result_Json,
						Created_At_Ms
					FROM Cloud_Changes
					WHERE ID_Change > ?1
					ORDER BY ID_Change ASC
					LIMIT ?2;
				`,
				args: [afterChangeId, limit + 1],
			});

			return r.rows ?? [];
		}

		throw e;
	}
}

export async function handleSyncChanges(
	req: Request,
	env: any,
	dbCentral: Client,
): Promise<Response> {
	try {
		const ctx: any = await buildTenantContext(
			req,
			env,
			dbCentral,
			createDbClient,
		);

		const tenantId = getTenantIdFromContext(ctx);
		if (!tenantId) {
			return unauthorized(req, "invalid_token_claims");
		}

		const db: Client = (ctx.dbTenant ?? ctx.db) as Client;
		if (!db) {
			throw new Error("tenant_db_missing");
		}

		const url = new URL(req.url);

		const body = await readJsonSafe<SyncChangesInput>(req, {
			afterId: 0,
			after_id: 0,
			afterChangeId: 0,
			after_change_id: 0,
			limit: 500,
		});

		const afterChangeId = Math.max(
			0,
			Math.floor(
				readNumber(
					body.afterId ??
					body.after_id ??
					body.afterChangeId ??
					body.after_change_id ??
					url.searchParams.get("afterId") ??
					url.searchParams.get("after_id") ??
					url.searchParams.get("afterChangeId") ??
					url.searchParams.get("after_change_id") ??
					0,
					0,
				),
			),
		);

		const limit = Math.max(
			1,
			Math.min(
				1000,
				Math.floor(
					readNumber(
						body.limit ?? url.searchParams.get("limit") ?? 500,
						500,
					),
				),
			),
		);

		let rows: any[];

		try {
			rows = await queryCloudChanges({
				db,
				afterChangeId,
				limit,
			});
		} catch (e: any) {
			const msg = String(e?.message || e);

			if (isMissingCloudChangesTable(msg)) {
				return emptySyncResponse(afterChangeId, req);
			}

			throw e;
		}

		const allRows = rows.map(mapChangeRow);
		const hasMore = allRows.length > limit;
		const items = hasMore ? allRows.slice(0, limit) : allRows;

		const lastChangeId =
			items.length > 0
				? Number(items[items.length - 1].idChange || afterChangeId)
				: afterChangeId;

		return json(
			{
				ok: true,

				// Compatibilidad con cloudSync.ts actual
				items,
				changes: items,

				lastChangeId,
				nextAfterId: lastChangeId,
				hasMore,
				serverTimeMs: Date.now(),

				// Formato estándar futuro
				data: {
					items,
					changes: items,
					lastChangeId,
					nextAfterId: lastChangeId,
					hasMore,
					serverTimeMs: Date.now(),
				},
			},
			200,
			req,
		);
	} catch (e: any) {
		const msg = String(e?.message || e);

		if (isAuthError(msg)) {
			return unauthorized(req, msg);
		}

		return serverError(req, "internal_error", {
			message: msg,
			name: e?.name,
			stack: e?.stack,
		});
	}
}