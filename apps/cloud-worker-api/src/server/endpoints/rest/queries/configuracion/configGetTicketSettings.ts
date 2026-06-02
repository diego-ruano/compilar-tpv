// src/server/endpoints/rest/queries/configuracion/configGetTicketSettings.ts

import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, unauthorized, serverError } from "../../../../utils/response";

function bool(v: any, fallback = true): boolean {
	if (v == null) return fallback;
	if (typeof v === "boolean") return v;
	if (typeof v === "number") return v !== 0;

	const s = String(v).trim().toLowerCase();
	if (["1", "true", "yes", "si", "sí"].includes(s)) return true;
	if (["0", "false", "no"].includes(s)) return false;

	return fallback;
}

function clampPaperWidthMm(v: any): number {
	const n = Number(v);
	return n === 58 || n === 80 || n === 112 ? n : 80;
}

export async function handleConfigGetTicketSettings(
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
                    Show_Logo AS show_logo,
                    Show_BusinessName AS show_business_name,
                    Show_Address AS show_address,
                    Show_Phone AS show_phone,
                    Show_CIF AS show_cif,
                    Show_DateTime AS show_date_time,
                    Show_LineItems AS show_line_items,
                    Show_BaseAndIVA AS show_base_and_iva,
                    Show_Total AS show_total,
                    Show_FooterMessage AS show_footer_message,
                    Paper_Width_Mm AS paper_width_mm
                FROM Ticket_Settings
                WHERE ID = 1
                LIMIT 1;
            `,
			args: [],
		});

		const row: any | undefined = (r.rows ?? [])[0] as any;

		if (!row) {
			return json(
				{
					show_logo: true,
					show_business_name: true,
					show_address: true,
					show_phone: true,
					show_cif: true,
					show_date_time: true,
					show_line_items: true,
					show_base_and_iva: true,
					show_total: true,
					show_footer_message: true,
					paper_width_mm: 80,
				},
				200,
				req,
			);
		}

		return json(
			{
				show_logo: bool(row.show_logo),
				show_business_name: bool(row.show_business_name),
				show_address: bool(row.show_address),
				show_phone: bool(row.show_phone),
				show_cif: bool(row.show_cif),
				show_date_time: bool(row.show_date_time),
				show_line_items: bool(row.show_line_items),
				show_base_and_iva: bool(row.show_base_and_iva),
				show_total: bool(row.show_total),
				show_footer_message: bool(row.show_footer_message),
				paper_width_mm: clampPaperWidthMm(row.paper_width_mm),
			},
			200,
			req,
		);
	} catch (e: any) {
		return serverError(req, "internal_error", String(e?.message || e));
	}
}