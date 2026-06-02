// src/server/endpoints/rest/queries/configuracion/configPatchTicketSettings.ts

import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, unauthorized, serverError } from "../../../../utils/response";
import {
	applyTenantHubTransaction,
	getDeviceIdFromContext,
	getTenantIdFromContext,
	readWriteRequest,
	type TxStep,
} from "../../../../utils/tenantHubWrites";

const COMMAND_NAME = "config.patchTicketSettings";

type PatchBody = {
	patch?: Record<string, any>;
};

type UpdateField = {
	column: string;
	value: number;
};

function hasOwn(obj: any, key: string): boolean {
	return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

function commandHeaderMismatch(req: Request): boolean {
	const h = String(req.headers.get("x-command-name") || "").trim();
	return !!h && h !== COMMAND_NAME;
}

function normalizePatch(raw: any): Record<string, any> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	return raw;
}

function boolPatchValue(v: any): boolean | null {
	if (typeof v === "boolean") return v;
	if (typeof v === "number") {
		if (v === 1) return true;
		if (v === 0) return false;
		return v !== 0;
	}

	const s = String(v ?? "").trim().toLowerCase();
	if (!s) return null;

	if (["1", "true", "t", "yes", "y", "si", "sí"].includes(s)) return true;
	if (["0", "false", "f", "no", "n"].includes(s)) return false;

	return null;
}

function boolToInt(v: boolean): number {
	return v ? 1 : 0;
}

function paperWidthPatchValue(v: any): number | null {
	const n = Number(v);
	return n === 58 || n === 80 || n === 112 ? n : null;
}

function pushBoolUpdate(
	updates: UpdateField[],
	patch: Record<string, any>,
	key: string,
	column: string,
): void {
	if (!hasOwn(patch, key)) return;

	const parsed = boolPatchValue(patch[key]);
	if (parsed == null) return;

	updates.push({
		column,
		value: boolToInt(parsed),
	});
}

function buildTicketUpdates(patch: Record<string, any>): UpdateField[] {
	const updates: UpdateField[] = [];

	pushBoolUpdate(updates, patch, "show_logo", "Show_Logo");
	pushBoolUpdate(updates, patch, "show_business_name", "Show_BusinessName");
	pushBoolUpdate(updates, patch, "show_address", "Show_Address");
	pushBoolUpdate(updates, patch, "show_phone", "Show_Phone");
	pushBoolUpdate(updates, patch, "show_cif", "Show_CIF");
	pushBoolUpdate(updates, patch, "show_date_time", "Show_DateTime");
	pushBoolUpdate(updates, patch, "show_line_items", "Show_LineItems");
	pushBoolUpdate(updates, patch, "show_base_and_iva", "Show_BaseAndIVA");
	pushBoolUpdate(updates, patch, "show_total", "Show_Total");
	pushBoolUpdate(updates, patch, "show_footer_message", "Show_FooterMessage");

	if (hasOwn(patch, "paper_width_mm")) {
		const parsed = paperWidthPatchValue(patch.paper_width_mm);
		if (parsed != null) {
			updates.push({
				column: "Paper_Width_Mm",
				value: parsed,
			});
		}
	}

	return updates;
}

function buildUpdateStep(updates: UpdateField[]): TxStep | null {
	if (updates.length === 0) return null;

	const sets = updates
		.map((u, i) => `${u.column} = ?${i + 1}`)
		.join(",\n                            ");

	const idParamIndex = updates.length + 1;

	return {
		kind: "execute",
		saveAs: "affected",
		sql: `
            UPDATE Ticket_Settings
            SET
                ${sets},
                Updated_At = datetime('now','localtime')
            WHERE ID = ?${idParamIndex};
        `,
		args: [...updates.map((u) => u.value), 1],
	};
}

export async function handleConfigPatchTicketSettings(
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

		if (commandHeaderMismatch(req)) {
			return json({ ok: false, error: "command_name_mismatch" }, 409, req);
		}

		const { input: body, opId } = await readWriteRequest<PatchBody>(req, {
			patch: {},
		});

		if (!opId) {
			return json({ ok: false, error: "missing_op_id" }, 400, req);
		}

		const patch = normalizePatch(body?.patch);
		const updates = buildTicketUpdates(patch);
		const updateStep = buildUpdateStep(updates);

		if (!updateStep) {
			return json("OK", 200, req);
		}

		await applyTenantHubTransaction<number>({
			env,
			tenantId,
			opId,
			commandName: COMMAND_NAME,
			deviceId: getDeviceIdFromContext(ctx),
			beginMode: "immediate",
			steps: [
				{
					kind: "execute",
					sql: `
                        INSERT OR IGNORE INTO Ticket_Settings (
                            ID,
                            Show_Logo,
                            Show_BusinessName,
                            Show_Address,
                            Show_Phone,
                            Show_CIF,
                            Show_DateTime,
                            Show_LineItems,
                            Show_BaseAndIVA,
                            Show_Total,
                            Show_FooterMessage,
                            Paper_Width_Mm,
                            Updated_At
                        )
                        VALUES (
                            1,
                            1,
                            1,
                            1,
                            1,
                            1,
                            1,
                            1,
                            1,
                            1,
                            1,
                            80,
                            datetime('now','localtime')
                        );
                    `,
					args: [],
				},
				updateStep,
			],
			resultKey: "affected",
		});

		return json("OK", 200, req);
	} catch (e: any) {
		return serverError(req, "internal_error", String(e?.message || e));
	}
}