// src/server/endpoints/rest/queries/configuracion/configGetBusinessSettings.ts

import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, unauthorized, serverError } from "../../../../utils/response";

function s(v: any, fallback = ""): string {
	if (v == null) return fallback;
	return String(v);
}

function n(v: any, fallback = 0): number {
	const x = Number(v);
	return Number.isFinite(x) ? x : fallback;
}

function optStr(v: any): string | null {
	if (v == null) return null;
	const t = String(v).trim();
	return t.length ? String(v) : null;
}

export async function handleConfigGetBusinessSettings(
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

		const db: Client = ctx.dbTenant;
		if (!ctx?.claims?.tenantId) {
			return unauthorized(req, "invalid_token_claims");
		}

		const r = await db.execute({
			sql: `
                SELECT
                    Business_Name AS business_name,
                    Logo_DataUrl AS logo_data_url,
                    Direccion AS direccion,
                    Telefono AS telefono,
                    CIF AS cif,
                    Mensaje_Footer AS mensaje_footer,
                    IVA_Percent AS iva_percent
                FROM Business_Settings
                WHERE ID = 1
                LIMIT 1;
            `,
			args: [],
		});

		const row: any | undefined = (r.rows ?? [])[0] as any;

		if (!row) {
			return json(
				{
					business_name: "TPV",
					logo_data_url: null,
					direccion: "",
					telefono: "",
					cif: "",
					mensaje_footer: "¡Gracias por su visita!",
					iva_percent: 10,
				},
				200,
				req,
			);
		}

		return json(
			{
				business_name: s(row.business_name, "TPV"),
				logo_data_url: optStr(row.logo_data_url),
				direccion: s(row.direccion, ""),
				telefono: s(row.telefono, ""),
				cif: s(row.cif, ""),
				mensaje_footer: s(row.mensaje_footer, "¡Gracias por su visita!"),
				iva_percent: n(row.iva_percent, 10),
			},
			200,
			req,
		);
	} catch (e: any) {
		return serverError(req, "internal_error", String(e?.message || e));
	}
}