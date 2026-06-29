// src/domains/configuracion/configuracion.commands.ts

import type { ApplyCommand } from "../../lib/hub";

export type BuiltCommand = {
	commandName: string;
	command: ApplyCommand;
	cloudPayload: any;
};

function cleanString(v: unknown): string | null {
	if (v == null) return null;
	return String(v);
}

function cleanLogo(v: unknown): string | null {
	const s = cleanString(v);
	if (s == null) return null;
	const t = s.trim();
	return t.length ? s : null;
}

function boolVal(v: unknown): boolean | null {
	if (typeof v === "boolean") return v;
	if (typeof v === "number") return v !== 0;
	if (typeof v === "string") {
		const s = v.trim().toLowerCase();
		if (["1", "true", "yes", "si", "sí"].includes(s)) return true;
		if (["0", "false", "no"].includes(s)) return false;
	}
	return null;
}

function clampPaperWidthMm(v: unknown): number | null {
	const n = Number(v);
	if (!Number.isFinite(n)) return null;
	return n === 58 || n === 80 || n === 112 ? n : 80;
}

export function patchContact(patch: Record<string, unknown>): BuiltCommand {
	const steps: any[] = [
		{ kind: "execute", sql: "INSERT OR IGNORE INTO Contact_Settings (ID) VALUES (1);" },
	];
	const sets: string[] = [];
	const args: any[] = [];

	function add(col: string, value: any) {
		sets.push(`${col} = ?${args.length + 1}`);
		args.push(value);
	}

	if ("recovery_email" in patch) add("Recovery_Email", cleanString(patch.recovery_email) ?? "");
	if ("contact_email" in patch) add("Contact_Email", cleanString(patch.contact_email) ?? "");
	if ("contact_phone" in patch) add("Contact_Phone", cleanString(patch.contact_phone) ?? "");

	if (sets.length) {
		sets.push("Updated_At = datetime('now','localtime')");
		steps.push({
			kind: "execute",
			sql: `UPDATE Contact_Settings SET ${sets.join(", ")} WHERE ID = 1;`,
			args,
		});
	}

	return {
		commandName: "config_patch_contact_settings",
		command: { type: "tenantDb.transaction", payload: { steps } },
		cloudPayload: { patch },
	};
}

export function patchBusiness(patch: Record<string, unknown>): BuiltCommand {
	const steps: any[] = [
		{ kind: "execute", sql: "INSERT OR IGNORE INTO Business_Settings (ID) VALUES (1);" },
	];
	const sets: string[] = [];
	const args: any[] = [];

	function add(col: string, value: any) {
		sets.push(`${col} = ?${args.length + 1}`);
		args.push(value);
	}

	if ("business_name" in patch) add("Business_Name", cleanString(patch.business_name) ?? "");
	if ("logo_data_url" in patch) add("Logo_DataUrl", cleanLogo(patch.logo_data_url));
	if ("direccion" in patch) add("Direccion", cleanString(patch.direccion) ?? "");
	if ("telefono" in patch) add("Telefono", cleanString(patch.telefono) ?? "");
	if ("cif" in patch) add("CIF", cleanString(patch.cif) ?? "");
	if ("mensaje_footer" in patch) add("Mensaje_Footer", cleanString(patch.mensaje_footer) ?? "");
	if ("iva_percent" in patch) {
		const n = Number(patch.iva_percent);
		if (Number.isFinite(n)) add("IVA_Percent", n);
	}

	if (sets.length) {
		sets.push("Updated_At = datetime('now','localtime')");
		steps.push({
			kind: "execute",
			sql: `UPDATE Business_Settings SET ${sets.join(", ")} WHERE ID = 1;`,
			args,
		});
	}

	return {
		commandName: "config_patch_business_settings",
		command: { type: "tenantDb.transaction", payload: { steps } },
		cloudPayload: { patch },
	};
}

export function patchTicket(patch: Record<string, unknown>): BuiltCommand {
	const steps: any[] = [
		{ kind: "execute", sql: "INSERT OR IGNORE INTO Ticket_Settings (ID) VALUES (1);" },
	];
	const sets: string[] = [];
	const args: any[] = [];

	function addBool(key: string, col: string) {
		if (!(key in patch)) return;
		const b = boolVal(patch[key]);
		if (b == null) return;
		sets.push(`${col} = ?${args.length + 1}`);
		args.push(b ? 1 : 0);
	}

	addBool("show_logo", "Show_Logo");
	addBool("show_business_name", "Show_BusinessName");
	addBool("show_address", "Show_Address");
	addBool("show_phone", "Show_Phone");
	addBool("show_cif", "Show_CIF");
	addBool("show_date_time", "Show_DateTime");
	addBool("show_line_items", "Show_LineItems");
	addBool("show_base_and_iva", "Show_BaseAndIVA");
	addBool("show_total", "Show_Total");
	addBool("show_footer_message", "Show_FooterMessage");

	if ("paper_width_mm" in patch) {
		const n = clampPaperWidthMm(patch.paper_width_mm);
		if (n != null) {
			sets.push(`Paper_Width_Mm = ?${args.length + 1}`);
			args.push(n);
		}
	}

	if (sets.length) {
		sets.push("Updated_At = datetime('now','localtime')");
		steps.push({
			kind: "execute",
			sql: `UPDATE Ticket_Settings SET ${sets.join(", ")} WHERE ID = 1;`,
			args,
		});
	}

	return {
		commandName: "config_patch_ticket_settings",
		command: { type: "tenantDb.transaction", payload: { steps } },
		cloudPayload: { patch },
	};
}
