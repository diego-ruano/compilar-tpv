// src/server/endpoints/rest/queries/configuracion/configPatchBusinessSettings.ts

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

const COMMAND_NAME = "config.patchBusinessSettings";

type PatchBody = {
	patch?: Record<string, any>;
};

type UpdateField = {
	column: string;
	value: string | number | null;
};

function s(v: any, fallback = ""): string {
	if (v == null) return fallback;
	return String(v);
}

function n(v: any, fallback = 0): number {
	const x = Number(v);
	return Number.isFinite(x) ? x : fallback;
}

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

function buildBusinessUpdates(patch: Record<string, any>): UpdateField[] {
	const updates: UpdateField[] = [];

	if (hasOwn(patch, "business_name")) {
		const v = String(patch.business_name ?? "").trim();
		updates.push({
			column: "Business_Name",
			value: v || "TPV",
		});
	}

	if (hasOwn(patch, "logo_data_url")) {
		if (patch.logo_data_url == null) {
			updates.push({
				column: "Logo_DataUrl",
				value: null,
			});
		} else {
			const v = String(patch.logo_data_url);
			updates.push({
				column: "Logo_DataUrl",
				value: v.trim() ? v : null,
			});
		}
	}

	if (hasOwn(patch, "direccion")) {
		updates.push({
			column: "Direccion",
			value: s(patch.direccion, ""),
		});
	}

	if (hasOwn(patch, "telefono")) {
		updates.push({
			column: "Telefono",
			value: s(patch.telefono, ""),
		});
	}

	if (hasOwn(patch, "cif")) {
		updates.push({
			column: "CIF",
			value: s(patch.cif, ""),
		});
	}

	if (hasOwn(patch, "mensaje_footer")) {
		updates.push({
			column: "Mensaje_Footer",
			value: s(patch.mensaje_footer, ""),
		});
	}

	if (hasOwn(patch, "iva_percent")) {
		updates.push({
			column: "IVA_Percent",
			value: n(patch.iva_percent, 10),
		});
	}

	return updates;
}

function buildUpdateStep(updates: UpdateField[]): TxStep | null {
	if (updates.length === 0) return null;

	const sets = updates
		.map((u, i) => `${u.column} = ?${i + 1}`)
		.join(",\n                            ");

	const updatedAtIndex = updates.length + 1;

	return {
		kind: "execute",
		saveAs: "affected",
		sql: `
            UPDATE Business_Settings
            SET
                ${sets},
                Updated_At = datetime('now','localtime')
            WHERE ID = ?${updatedAtIndex};
        `,
		args: [...updates.map((u) => u.value), 1],
	};
}

export async function handleConfigPatchBusinessSettings(
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
		const updates = buildBusinessUpdates(patch);
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
                        INSERT OR IGNORE INTO Business_Settings (
                            ID,
                            Business_Name,
                            Logo_DataUrl,
                            Direccion,
                            Telefono,
                            CIF,
                            Mensaje_Footer,
                            IVA_Percent,
                            Updated_At
                        )
                        VALUES (
                            1,
                            'TPV',
                            NULL,
                            '',
                            '',
                            '',
                            '¡Gracias por su visita!',
                            10,
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