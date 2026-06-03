// src/features/configuracion/api/configApis.ts
//
// API de configuración — Local-First puro (invokeClient, sin dualCall/op_id/afterRemoteOk).
// Tipos UI (camelCase) y mappers intactos; sólo cambia el transporte.

import { invokeClient } from "@tpv/client";

/* ── Types frontend ── */

export type BusinessSettings = {
    businessName: string;
    logoDataUrl: string | null;
    direccion: string;
    telefono: string;
    cif: string;
    mensajeFooter: string;
    ivaPercent: number;
};

export type TicketSettings = {
    showLogo: boolean;
    showBusinessName: boolean;
    showAddress: boolean;
    showPhone: boolean;
    showCif: boolean;
    showDateTime: boolean;
    showLineItems: boolean;
    showBaseAndIva: boolean;
    showTotal: boolean;
    showFooterMessage: boolean;
    paperWidthMm: number;
};

export type BusinessSettingsPatch = Partial<BusinessSettings>;
export type TicketSettingsPatch = Partial<TicketSettings>;

/* ── Helpers ── */

function pick(obj: any, keys: string[], fallback?: any): any {
    for (const k of keys) {
        if (obj && obj[k] !== undefined) return obj[k];
    }
    return fallback;
}

function num(v: any, fallback: number): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function clampPaperWidthMm(n: number): number {
    return n === 58 || n === 80 || n === 112 ? n : 80;
}

function mapBizFromRust(x: any): BusinessSettings {
    return {
        businessName: String(pick(x, ["business_name", "businessName"], "TPV")),
        logoDataUrl: pick(x, ["logo_data_url", "logoDataUrl"], null) ?? null,
        direccion: String(pick(x, ["direccion"], "")),
        telefono: String(pick(x, ["telefono"], "")),
        cif: String(pick(x, ["cif"], "")),
        mensajeFooter: String(
            pick(x, ["mensaje_footer", "mensajeFooter"], "¡Gracias por su visita!"),
        ),
        ivaPercent: num(pick(x, ["iva_percent", "ivaPercent"]), 10),
    };
}

function mapBizPatchToRust(patch: BusinessSettingsPatch): Record<string, any> {
    const out: Record<string, any> = {};
    if ("businessName" in patch) out.business_name = patch.businessName;
    if ("logoDataUrl" in patch) out.logo_data_url = patch.logoDataUrl;
    if ("direccion" in patch) out.direccion = patch.direccion;
    if ("telefono" in patch) out.telefono = patch.telefono;
    if ("cif" in patch) out.cif = patch.cif;
    if ("mensajeFooter" in patch) out.mensaje_footer = patch.mensajeFooter;
    if ("ivaPercent" in patch) out.iva_percent = patch.ivaPercent;
    return out;
}

function mapTicketFromRust(x: any): TicketSettings {
    return {
        showLogo: !!pick(x, ["show_logo", "showLogo"], true),
        showBusinessName: !!pick(x, ["show_business_name", "showBusinessName"], true),
        showAddress: !!pick(x, ["show_address", "showAddress"], true),
        showPhone: !!pick(x, ["show_phone", "showPhone"], true),
        showCif: !!pick(x, ["show_cif", "showCif"], true),
        showDateTime: !!pick(x, ["show_date_time", "showDateTime"], true),
        showLineItems: !!pick(x, ["show_line_items", "showLineItems"], true),
        showBaseAndIva: !!pick(x, ["show_base_and_iva", "showBaseAndIva"], true),
        showTotal: !!pick(x, ["show_total", "showTotal"], true),
        showFooterMessage: !!pick(x, ["show_footer_message", "showFooterMessage"], true),
        paperWidthMm: clampPaperWidthMm(num(pick(x, ["paper_width_mm", "paperWidthMm"]), 80)),
    };
}

function mapTicketPatchToRust(patch: TicketSettingsPatch): Record<string, any> {
    const out: Record<string, any> = {};
    if ("showLogo" in patch) out.show_logo = patch.showLogo;
    if ("showBusinessName" in patch) out.show_business_name = patch.showBusinessName;
    if ("showAddress" in patch) out.show_address = patch.showAddress;
    if ("showPhone" in patch) out.show_phone = patch.showPhone;
    if ("showCif" in patch) out.show_cif = patch.showCif;
    if ("showDateTime" in patch) out.show_date_time = patch.showDateTime;
    if ("showLineItems" in patch) out.show_line_items = patch.showLineItems;
    if ("showBaseAndIva" in patch) out.show_base_and_iva = patch.showBaseAndIva;
    if ("showTotal" in patch) out.show_total = patch.showTotal;
    if ("showFooterMessage" in patch) out.show_footer_message = patch.showFooterMessage;
    if ("paperWidthMm" in patch) {
        out.paper_width_mm = clampPaperWidthMm(Number(patch.paperWidthMm));
    }
    return out;
}

/* ── API (Local-First) ── */

export async function configGetBusinessSettings(): Promise<BusinessSettings> {
    const raw = await invokeClient<any>("config_get_business_settings");
    return mapBizFromRust(raw);
}

export async function configPatchBusinessSettings(
    patch: BusinessSettingsPatch,
): Promise<void> {
    if (!patch || Object.keys(patch).length === 0) return;
    const patchRust = mapBizPatchToRust(patch);
    if (Object.keys(patchRust).length === 0) return;
    await invokeClient<string>("config_patch_business_settings", {
        args: { patch: patchRust },
    });
}

export async function configGetTicketSettings(): Promise<TicketSettings> {
    const raw = await invokeClient<any>("config_get_ticket_settings");
    return mapTicketFromRust(raw);
}

export async function configPatchTicketSettings(
    patch: TicketSettingsPatch,
): Promise<void> {
    if (!patch || Object.keys(patch).length === 0) return;
    const patchRust = mapTicketPatchToRust(patch);
    if (Object.keys(patchRust).length === 0) return;
    await invokeClient<string>("config_patch_ticket_settings", {
        args: { patch: patchRust },
    });
}
