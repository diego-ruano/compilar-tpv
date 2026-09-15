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

function clampPaperDpi(v: unknown): number | null {
	const n = Number(v);
	if (!Number.isFinite(n)) return null;
	return n === 300 ? 300 : 203;
}
function clampCharsPerLine(v: unknown): number | null {
	const n = Number(v);
	if (!Number.isFinite(n)) return null;
	return Math.min(80, Math.max(20, Math.round(n)));
}
function clampMarginMm(v: unknown): number | null {
	const n = Number(v);
	if (!Number.isFinite(n)) return null;
	return Math.min(25, Math.max(0, n));
}
function clampFontScale(v: unknown): number | null {
	const n = Number(v);
	if (!Number.isFinite(n)) return null;
	return Math.min(2, Math.max(0.5, n));
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
	if ("umbral_descuadre" in patch) {
		const n = Number(patch.umbral_descuadre);
		if (Number.isFinite(n)) add("Umbral_Descuadre", n);
	}

	// FISCAL-01. Los datos fiscales (`Razon_Social`, `Descripcion_Op`, `Limite_Simplif`,
	// `Verifactu_Entorno`) NO se escriben desde aquí, y esto es la decisión, no un olvido: quien
	// emite los registros es la Main y es la única que puede comprobar lo que hace falta antes de
	// tocarlos —que el NIF sigue siendo el de la cadena ya emitida, por ejemplo—. Este builder lo
	// sirve la API REST, o sea la Handy, que ve esos campos en solo lectura.
	//
	// Como el `patch` es un `Record<string, unknown>`, las claves desconocidas se ignoran solas.
	// Se dice aquí para que quien añada la siguiente línea vea por qué faltan estas cuatro.

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

	function addNum(key: string, col: string, clamp: (v: unknown) => number | null) {
		if (!(key in patch)) return;
		const n = clamp(patch[key]);
		if (n == null) return;
		sets.push(`${col} = ?${args.length + 1}`);
		args.push(n);
	}

	addNum("paper_width_mm", "Paper_Width_Mm", clampPaperWidthMm);
	addNum("paper_dpi", "Paper_Dpi", clampPaperDpi);
	addNum("chars_per_line", "Chars_Per_Line", clampCharsPerLine);
	addNum("margin_top_mm", "Margin_Top_Mm", clampMarginMm);
	addNum("margin_bottom_mm", "Margin_Bottom_Mm", clampMarginMm);
	addNum("margin_left_mm", "Margin_Left_Mm", clampMarginMm);
	addNum("margin_right_mm", "Margin_Right_Mm", clampMarginMm);
	addNum("font_scale", "Font_Scale", clampFontScale);

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
