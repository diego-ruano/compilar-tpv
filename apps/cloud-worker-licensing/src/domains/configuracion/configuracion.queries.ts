// src/domains/configuracion/configuracion.queries.ts

import type { Client } from "@libsql/client/web";
import { deLaBase } from "../../lib/dinero";

import type { BusinessSettings, ContactSettings, TicketSettings } from "@tpv/contracts";

function rows(rs: any): any[] {
	const cols: string[] = rs?.columns ?? [];
	return (rs?.rows ?? []).map((r: any) => {
		if (r && typeof r === "object" && !Array.isArray(r)) return r;
		const o: Record<string, any> = {};
		cols.forEach((col, i) => {
			o[col] = r[i];
		});
		return o;
	});
}

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
function clampPaperDpi(v: any): number {
	return Number(v) === 300 ? 300 : 203;
}
function clampCharsPerLine(v: any): number {
	const n = Number(v);
	return Number.isFinite(n) ? Math.min(80, Math.max(20, Math.round(n))) : 42;
}
function clampMarginMm(v: any): number {
	const n = Number(v);
	return Number.isFinite(n) ? Math.min(25, Math.max(0, n)) : 0;
}
function clampFontScale(v: any): number {
	const n = Number(v);
	return Number.isFinite(n) ? Math.min(2, Math.max(0.5, n)) : 1;
}

export async function getBusiness(db: Client): Promise<BusinessSettings> {
	const rs = await db.execute(`
		SELECT
			Business_Name AS business_name,
			Logo_DataUrl AS logo_data_url,
			Direccion AS direccion,
			Telefono AS telefono,
			CIF AS cif,
			Mensaje_Footer AS mensaje_footer,
			IVA_Percent AS iva_percent,
			Umbral_Descuadre AS umbral_descuadre,
			Razon_Social AS razon_social,
			Descripcion_Op AS descripcion_op,
			Limite_Simplif AS limite_simplif,
			Verifactu_Entorno AS verifactu_entorno
		FROM Business_Settings
		WHERE ID=1
		LIMIT 1;
	`);
	const r = rows(rs)[0] ?? {};
	return {
		business_name: String(r.business_name ?? "TPV"),
		logo_data_url: r.logo_data_url == null ? null : String(r.logo_data_url),
		direccion: String(r.direccion ?? ""),
		telefono: String(r.telefono ?? ""),
		cif: String(r.cif ?? ""),
		mensaje_footer: String(r.mensaje_footer ?? "¡Gracias por su visita!"),
		iva_percent: Number(r.iva_percent ?? 10),
		// CUENTA-06: a partir de cuanto descuadre el cierre de caja pide un motivo escrito.
		// El defecto va en centimos, como la columna: 5 EUR son 500.
		umbral_descuadre: deLaBase(r.umbral_descuadre ?? 500),
		// FISCAL-01. La Handy los LEE (los enseña en la pantalla de configuración, en solo lectura)
		// pero no los toca: quien emite es la Main. `razon_social` puede venir vacía mientras nadie
		// haya completado el formulario fiscal, y eso es justo lo que la pantalla tiene que decir.
		razon_social: String(r.razon_social ?? ""),
		descripcion_op: String(r.descripcion_op ?? "Servicios de hosteleria y restauracion"),
		limite_simplif: deLaBase(r.limite_simplif ?? 300_000),
		verifactu_entorno: r.verifactu_entorno === "pruebas" ? "pruebas" : "produccion",
	};
}

export async function getContact(db: Client): Promise<ContactSettings> {
	const rs = await db.execute(`
		SELECT
			Contact_Email AS contact_email,
			Contact_Phone AS contact_phone
		FROM Contact_Settings
		WHERE ID=1
		LIMIT 1;
	`);
	const r = rows(rs)[0] ?? {};
	return {
		contact_email: String(r.contact_email ?? ""),
		contact_phone: String(r.contact_phone ?? ""),
	};
}

export async function getTicket(db: Client): Promise<TicketSettings> {
	const rs = await db.execute(`
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
			Paper_Width_Mm AS paper_width_mm,
			Paper_Dpi AS paper_dpi,
			Chars_Per_Line AS chars_per_line,
			Margin_Top_Mm AS margin_top_mm,
			Margin_Bottom_Mm AS margin_bottom_mm,
			Margin_Left_Mm AS margin_left_mm,
			Margin_Right_Mm AS margin_right_mm,
			Font_Scale AS font_scale
		FROM Ticket_Settings
		WHERE ID=1
		LIMIT 1;
	`);
	const r = rows(rs)[0] ?? {};
	return {
		show_logo: bool(r.show_logo),
		show_business_name: bool(r.show_business_name),
		show_address: bool(r.show_address),
		show_phone: bool(r.show_phone),
		show_cif: bool(r.show_cif),
		show_date_time: bool(r.show_date_time),
		show_line_items: bool(r.show_line_items),
		show_base_and_iva: bool(r.show_base_and_iva),
		show_total: bool(r.show_total),
		show_footer_message: bool(r.show_footer_message),
		paper_width_mm: clampPaperWidthMm(r.paper_width_mm),
		paper_dpi: clampPaperDpi(r.paper_dpi),
		chars_per_line: clampCharsPerLine(r.chars_per_line),
		margin_top_mm: clampMarginMm(r.margin_top_mm),
		margin_bottom_mm: clampMarginMm(r.margin_bottom_mm),
		margin_left_mm: clampMarginMm(r.margin_left_mm),
		margin_right_mm: clampMarginMm(r.margin_right_mm),
		font_scale: clampFontScale(r.font_scale),
	};
}
