// src/features/configuracion/api/configApis.ts
//
// API de configuración. Lo que llega de Rust son los DTO generados por ts-rs; aquí se traducen a
// la forma de los stores de Zustand (camelCase), que es estado de la aplicación y no un contrato:
// la configuración se carga una vez y la leen muchas pantallas. Pasar esos stores a los nombres
// del DTO queda para RI-87.

import { invokeClient } from "@tpv/client";
import type {
    BusinessSettings as BusinessSettingsDto,
    ContactSettings as ContactSettingsDto,
    Dinero,
    TicketSettings as TicketSettingsDto,
} from "@tpv/contracts";

/* ── Types frontend ── */

export type ContactSettings = {
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
    limiteSimplif: Dinero;
    /** `"produccion"` | `"pruebas"`. Cambia a la vez el endpoint y la URL del QR del papel. */
    verifactuEntorno: string;

    // ── Reservas (RI-61) ────────────────────────────────────────────────────────────────────
    /** Minutos que dura una reserva que no elige su duración. */
    reservaDuracionMin: number;
    /** Qué pasa cuando dos reservas de la misma mesa se pisan. */
    reservaSolape: "avisar" | "prohibir";
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

function mapBizFromRust(x: BusinessSettingsDto): BusinessSettings {
    return {
        businessName: x.business_name,
        logoDataUrl: x.logo_data_url,
        direccion: x.direccion,
        telefono: x.telefono,
        cif: x.cif,
        mensajeFooter: x.mensaje_footer,
        ivaPercent: x.iva_percent,
        razonSocial: x.razon_social,
        descripcionOp: x.descripcion_op,
        limiteSimplif: x.limite_simplif,
        verifactuEntorno: x.verifactu_entorno === "pruebas" ? "pruebas" : "produccion",
        reservaDuracionMin: x.reserva_duracion_min,
        reservaSolape: x.reserva_solape === "prohibir" ? "prohibir" : "avisar",
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
    if ("reservaDuracionMin" in patch) out.reserva_duracion_min = patch.reservaDuracionMin;
    if ("reservaSolape" in patch) out.reserva_solape = patch.reservaSolape;
    return out;
}

function mapTicketFromRust(x: TicketSettingsDto): TicketSettings {
    return {
        showLogo: x.show_logo,
        showBusinessName: x.show_business_name,
        showAddress: x.show_address,
        showPhone: x.show_phone,
        showCif: x.show_cif,
        showDateTime: x.show_date_time,
        showLineItems: x.show_line_items,
        showBaseAndIva: x.show_base_and_iva,
        showTotal: x.show_total,
        showFooterMessage: x.show_footer_message,
        paperWidthMm: clampPaperWidthMm(x.paper_width_mm),
        paperDpi: clampPaperDpi(x.paper_dpi),
        charsPerLine: clampCharsPerLine(x.chars_per_line),
        marginTopMm: clampMarginMm(x.margin_top_mm),
        marginBottomMm: clampMarginMm(x.margin_bottom_mm),
        marginLeftMm: clampMarginMm(x.margin_left_mm),
        marginRightMm: clampMarginMm(x.margin_right_mm),
        fontScale: clampFontScale(x.font_scale),
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

function mapContactFromRust(x: ContactSettingsDto): ContactSettings {
    return { contactEmail: x.contact_email, contactPhone: x.contact_phone };
}

function mapContactPatchToRust(patch: Partial<ContactSettings>): Record<string, any> {
    const out: Record<string, any> = {};
    if ("contactEmail" in patch) out.contact_email = patch.contactEmail;
    if ("contactPhone" in patch) out.contact_phone = patch.contactPhone;
    return out;
}

/* ── API (Local-First) ── */

export async function configGetContactSettings(): Promise<ContactSettings> {
    const raw = await invokeClient<ContactSettingsDto>("config_get_contact_settings");
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
    const raw = await invokeClient<BusinessSettingsDto>("config_get_business_settings");
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
    const raw = await invokeClient<TicketSettingsDto>("config_get_ticket_settings");
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
