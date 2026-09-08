// src/features/configuracion/api/configApis.ts
//
// API de configuración — Local-First puro (invokeClient, sin dualCall/op_id/afterRemoteOk).
// Tipos UI (camelCase) y mappers intactos; sólo cambia el transporte.

import { invokeClient } from "@tpv/client";

/* ── Types frontend ── */

export type ContactSettings = {
    recoveryEmail: string;
    contactEmail: string;
    contactPhone: string;
};

export type BusinessSettings = {
    businessName: string;
    logoDataUrl: string | null;
    direccion: string;
    telefono: string;
    cif: string;
    mensajeFooter: string;
    ivaPercent: number;

    // ── Datos fiscales (FISCAL-01, Veri*factu) ──────────────────────────────────────────────
    /**
     * `NombreRazon` del obligado a expedir la factura. **No es `businessName`**: uno es el rótulo
     * («Bar La Plaza») y el otro quien factura («Francisco García SL»). El ticket enseña los dos;
     * el registro que se remite a la AEAT, sólo este.
     */
    razonSocial: string;
    /**
     * `DescripcionOperacion`: campo obligatorio del registro, de hasta 500 caracteres. Texto fijo y
     * no un resumen de las líneas — los nombres de producto los escribe el usuario, y un campo
     * obligatorio que puede llegar con basura es un rechazo garantizado.
     */
    descripcionOp: string;
    /** Límite (IVA incluido) por encima del cual ya no cabe una simplificada. 3.000 € en hostelería. */
    limiteSimplif: number;
    /** `"produccion"` | `"pruebas"`. Cambia a la vez el endpoint y la URL del QR del papel. */
    verifactuEntorno: string;
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

    // Parámetros finos de impresión (respetados por el renderizado ESC/POS).
    paperDpi: number;
    charsPerLine: number;
    marginTopMm: number;
    marginBottomMm: number;
    marginLeftMm: number;
    marginRightMm: number;
    fontScale: number;
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

function clampPaperDpi(n: number): number {
    return n === 300 ? 300 : 203;
}
function clampCharsPerLine(n: number): number {
    return Math.min(80, Math.max(20, Math.round(n)));
}
function clampMarginMm(n: number): number {
    return Math.min(25, Math.max(0, n));
}
function clampFontScale(n: number): number {
    return Math.min(2, Math.max(0.5, n));
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
        razonSocial: String(pick(x, ["razon_social", "razonSocial"], "")),
        descripcionOp: String(
            pick(x, ["descripcion_op", "descripcionOp"], "Servicios de hosteleria y restauracion"),
        ),
        limiteSimplif: num(pick(x, ["limite_simplif", "limiteSimplif"]), 3000),
        verifactuEntorno:
            String(pick(x, ["verifactu_entorno", "verifactuEntorno"], "produccion")) === "pruebas"
                ? "pruebas"
                : "produccion",
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
    if ("razonSocial" in patch) out.razon_social = patch.razonSocial;
    if ("descripcionOp" in patch) out.descripcion_op = patch.descripcionOp;
    if ("limiteSimplif" in patch) out.limite_simplif = patch.limiteSimplif;
    if ("verifactuEntorno" in patch) out.verifactu_entorno = patch.verifactuEntorno;
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
        paperDpi: clampPaperDpi(num(pick(x, ["paper_dpi", "paperDpi"]), 203)),
        charsPerLine: clampCharsPerLine(num(pick(x, ["chars_per_line", "charsPerLine"]), 42)),
        marginTopMm: clampMarginMm(num(pick(x, ["margin_top_mm", "marginTopMm"]), 0)),
        marginBottomMm: clampMarginMm(num(pick(x, ["margin_bottom_mm", "marginBottomMm"]), 0)),
        marginLeftMm: clampMarginMm(num(pick(x, ["margin_left_mm", "marginLeftMm"]), 0)),
        marginRightMm: clampMarginMm(num(pick(x, ["margin_right_mm", "marginRightMm"]), 0)),
        fontScale: clampFontScale(num(pick(x, ["font_scale", "fontScale"]), 1)),
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
    if ("paperDpi" in patch) out.paper_dpi = clampPaperDpi(Number(patch.paperDpi));
    if ("charsPerLine" in patch) out.chars_per_line = clampCharsPerLine(Number(patch.charsPerLine));
    if ("marginTopMm" in patch) out.margin_top_mm = clampMarginMm(Number(patch.marginTopMm));
    if ("marginBottomMm" in patch) out.margin_bottom_mm = clampMarginMm(Number(patch.marginBottomMm));
    if ("marginLeftMm" in patch) out.margin_left_mm = clampMarginMm(Number(patch.marginLeftMm));
    if ("marginRightMm" in patch) out.margin_right_mm = clampMarginMm(Number(patch.marginRightMm));
    if ("fontScale" in patch) out.font_scale = clampFontScale(Number(patch.fontScale));
    return out;
}

function mapContactFromRust(x: any): ContactSettings {
    return {
        recoveryEmail: String(pick(x, ["recovery_email", "recoveryEmail"], "")),
        contactEmail: String(pick(x, ["contact_email", "contactEmail"], "")),
        contactPhone: String(pick(x, ["contact_phone", "contactPhone"], "")),
    };
}

function mapContactPatchToRust(patch: Partial<ContactSettings>): Record<string, any> {
    const out: Record<string, any> = {};
    if ("recoveryEmail" in patch) out.recovery_email = patch.recoveryEmail;
    if ("contactEmail" in patch) out.contact_email = patch.contactEmail;
    if ("contactPhone" in patch) out.contact_phone = patch.contactPhone;
    return out;
}

/* ── API (Local-First) ── */

export async function configGetContactSettings(): Promise<ContactSettings> {
    const raw = await invokeClient<any>("config_get_contact_settings");
    return mapContactFromRust(raw);
}

export async function configPatchContactSettings(
    patch: Partial<ContactSettings>,
): Promise<void> {
    if (!patch || Object.keys(patch).length === 0) return;
    const patchRust = mapContactPatchToRust(patch);
    if (Object.keys(patchRust).length === 0) return;
    await invokeClient<string>("config_patch_contact_settings", {
        args: { patch: patchRust },
    });
}

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
