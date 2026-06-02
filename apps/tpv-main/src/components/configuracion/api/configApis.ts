// src/components/config/api/configApi.ts
import { invoke } from "@tauri-apps/api/core";
import { dualCall } from "../../../net/dualCall";

/* ──────────────────────────────────────────────────────────────
   Types frontend
────────────────────────────────────────────────────────────── */

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

type ConfigPatchDomainArgs = {
    patch: Record<string, any>;
};

type LocalConfigPatchArgs = ConfigPatchDomainArgs & {
    op_id: string;
    enqueue_outbox?: boolean;
};

type CommandBody<TArgs extends Record<string, any>> = {
    op_id: string;
    command_name: string;
    args: TArgs;
};

/* ──────────────────────────────────────────────────────────────
   Constantes
────────────────────────────────────────────────────────────── */

const COMMAND_PATCH_BUSINESS_SETTINGS = "config.patchBusinessSettings";
const COMMAND_PATCH_TICKET_SETTINGS = "config.patchTicketSettings";

/* ──────────────────────────────────────────────────────────────
   Helpers
────────────────────────────────────────────────────────────── */

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

function makeOpId(scope: string): string {
    const prefix = scope.replace(/[^a-zA-Z0-9_-]/g, "_");

    if (
        typeof crypto !== "undefined" &&
        typeof crypto.randomUUID === "function"
    ) {
        return `${prefix}-${crypto.randomUUID()}`;
    }

    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function commandBody<TArgs extends Record<string, any>>(
    opId: string,
    commandName: string,
    args: TArgs,
): CommandBody<TArgs> {
    return {
        op_id: opId,
        command_name: commandName,
        args,
    };
}

function localWriteArgs(
    opId: string,
    domainArgs: ConfigPatchDomainArgs,
    enqueueOutbox = true,
): LocalConfigPatchArgs {
    return {
        op_id: opId,
        ...domainArgs,
        enqueue_outbox: enqueueOutbox,
    };
}

function unwrapMaybeOkEnvelope<T>(x: any): T {
    if (!x || typeof x !== "object") return x as T;
    if (!("ok" in x)) return x as T;

    if (!x.ok) {
        const msg = String(x.error ?? x.message ?? "remote_ok_false");
        throw new Error(msg);
    }

    if ("result" in x) return x.result as T;
    if ("user" in x) return x.user as T;
    if ("status" in x) return x.status as T;
    if ("data" in x) return x.data as T;

    return x as T;
}

function mapBizFromRust(x: any): BusinessSettings {
    return {
        businessName: String(
            pick(x, ["business_name", "businessName", "Business_Name"], "TPV"),
        ),
        logoDataUrl:
            pick(x, ["logo_data_url", "logoDataUrl", "Logo_DataUrl"], null) ??
            null,
        direccion: String(pick(x, ["direccion", "Direccion"], "")),
        telefono: String(pick(x, ["telefono", "Telefono"], "")),
        cif: String(pick(x, ["cif", "CIF"], "")),
        mensajeFooter: String(
            pick(
                x,
                ["mensaje_footer", "mensajeFooter", "Mensaje_Footer"],
                "¡Gracias por su visita!",
            ),
        ),
        ivaPercent: num(
            pick(x, ["iva_percent", "ivaPercent", "IVA_Percent"]),
            10,
        ),
    };
}

/**
 * Patch para Rust/backend:
 * - undefined -> no tocar
 * - null      -> borrar logo
 * - string    -> establecer logo
 */
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
        showLogo: !!pick(x, ["show_logo", "showLogo", "Show_Logo"], true),
        showBusinessName: !!pick(
            x,
            ["show_business_name", "showBusinessName", "Show_BusinessName"],
            true,
        ),
        showAddress: !!pick(
            x,
            ["show_address", "showAddress", "Show_Address"],
            true,
        ),
        showPhone: !!pick(x, ["show_phone", "showPhone", "Show_Phone"], true),
        showCif: !!pick(x, ["show_cif", "showCif", "Show_CIF"], true),
        showDateTime: !!pick(
            x,
            ["show_date_time", "showDateTime", "Show_DateTime"],
            true,
        ),
        showLineItems: !!pick(
            x,
            ["show_line_items", "showLineItems", "Show_LineItems"],
            true,
        ),
        showBaseAndIva: !!pick(
            x,
            ["show_base_and_iva", "showBaseAndIva", "Show_BaseAndIVA"],
            true,
        ),
        showTotal: !!pick(x, ["show_total", "showTotal", "Show_Total"], true),
        showFooterMessage: !!pick(
            x,
            ["show_footer_message", "showFooterMessage", "Show_FooterMessage"],
            true,
        ),
        paperWidthMm: clampPaperWidthMm(
            num(
                pick(x, ["paper_width_mm", "paperWidthMm", "Paper_Width_Mm"]),
                80,
            ),
        ),
    };
}

function mapTicketPatchToRust(patch: TicketSettingsPatch): Record<string, any> {
    const out: Record<string, any> = {};

    if ("showLogo" in patch) out.show_logo = patch.showLogo;
    if ("showBusinessName" in patch) {
        out.show_business_name = patch.showBusinessName;
    }
    if ("showAddress" in patch) out.show_address = patch.showAddress;
    if ("showPhone" in patch) out.show_phone = patch.showPhone;
    if ("showCif" in patch) out.show_cif = patch.showCif;
    if ("showDateTime" in patch) out.show_date_time = patch.showDateTime;
    if ("showLineItems" in patch) out.show_line_items = patch.showLineItems;
    if ("showBaseAndIva" in patch) out.show_base_and_iva = patch.showBaseAndIva;
    if ("showTotal" in patch) out.show_total = patch.showTotal;
    if ("showFooterMessage" in patch) {
        out.show_footer_message = patch.showFooterMessage;
    }
    if ("paperWidthMm" in patch) {
        out.paper_width_mm = clampPaperWidthMm(Number(patch.paperWidthMm));
    }

    return out;
}

/* ──────────────────────────────────────────────────────────────
   Local calls
────────────────────────────────────────────────────────────── */

async function localPatchBusinessSettings(
    args: LocalConfigPatchArgs,
): Promise<void> {
    await invoke<void>("config_patch_business_settings", { args });
}

async function localPatchTicketSettings(
    args: LocalConfigPatchArgs,
): Promise<void> {
    await invoke<void>("config_patch_ticket_settings", { args });
}

/* ──────────────────────────────────────────────────────────────
   API
────────────────────────────────────────────────────────────── */

export async function configGetBusinessSettings(): Promise<BusinessSettings> {
    const raw = await dualCall<any>(
        {
            path: "/v1/config/business",
            method: "GET",
            unwrapOkEnvelope: true,
        },
        () => invoke<any>("config_get_business_settings"),
        {
            kind: "read",
            debugTag: "config:getBusinessSettings",
            fallbackToLocalOnAvailabilityError: true,
        },
    );

    return mapBizFromRust(unwrapMaybeOkEnvelope<any>(raw));
}

export async function configPatchBusinessSettings(
    patch: BusinessSettingsPatch,
): Promise<void> {
    if (!patch || Object.keys(patch).length === 0) return;

    const patchRust = mapBizPatchToRust(patch);
    if (Object.keys(patchRust).length === 0) return;

    const opId = makeOpId("config_patch_business_settings");
    const domainArgs: ConfigPatchDomainArgs = {
        patch: patchRust,
    };

    await dualCall<void>(
        {
            path: "/v1/config/business/patch",
            method: "POST",
            body: commandBody(
                opId,
                COMMAND_PATCH_BUSINESS_SETTINGS,
                domainArgs,
            ),
            unwrapOkEnvelope: true,
        },
        () => localPatchBusinessSettings(localWriteArgs(opId, domainArgs, true)),
        {
            kind: "write",
            commandName: COMMAND_PATCH_BUSINESS_SETTINGS,
            debugTag: "config:patchBusinessSettings",
            fallbackToLocalOnAvailabilityError: true,
            afterRemoteOk: async () => {
                await localPatchBusinessSettings(
                    localWriteArgs(opId, domainArgs, false),
                );
            },
        },
    );
}

export async function configGetTicketSettings(): Promise<TicketSettings> {
    const raw = await dualCall<any>(
        {
            path: "/v1/config/ticket",
            method: "GET",
            unwrapOkEnvelope: true,
        },
        () => invoke<any>("config_get_ticket_settings"),
        {
            kind: "read",
            debugTag: "config:getTicketSettings",
            fallbackToLocalOnAvailabilityError: true,
        },
    );

    return mapTicketFromRust(unwrapMaybeOkEnvelope<any>(raw));
}

export async function configPatchTicketSettings(
    patch: TicketSettingsPatch,
): Promise<void> {
    if (!patch || Object.keys(patch).length === 0) return;

    const patchRust = mapTicketPatchToRust(patch);
    if (Object.keys(patchRust).length === 0) return;

    const opId = makeOpId("config_patch_ticket_settings");
    const domainArgs: ConfigPatchDomainArgs = {
        patch: patchRust,
    };

    await dualCall<void>(
        {
            path: "/v1/config/ticket/patch",
            method: "POST",
            body: commandBody(opId, COMMAND_PATCH_TICKET_SETTINGS, domainArgs),
            unwrapOkEnvelope: true,
        },
        () => localPatchTicketSettings(localWriteArgs(opId, domainArgs, true)),
        {
            kind: "write",
            commandName: COMMAND_PATCH_TICKET_SETTINGS,
            debugTag: "config:patchTicketSettings",
            fallbackToLocalOnAvailabilityError: true,
            afterRemoteOk: async () => {
                await localPatchTicketSettings(
                    localWriteArgs(opId, domainArgs, false),
                );
            },
        },
    );
}