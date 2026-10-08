import { commands } from "@tpv/client";
import type {
    BusinessSettings as NegocioDto,
    TicketSettings as TicketDto,
    ContactSettings,
    BusinessSettingsPatch,
    TicketSettingsPatch,
    ContactSettingsPatch,
} from "@tpv/contracts";

// El formulario necesita números para sus controles. Los campos y sus tipos proceden del DTO;
// sólo damos un valor de presentación a los flotantes que JSON puede serializar como null.
type NumerosDefinidos<T> = { [K in keyof T]: number extends T[K] ? NonNullable<T[K]> : T[K] };
export type BusinessSettings = NumerosDefinidos<NegocioDto>;
export type TicketSettings = NumerosDefinidos<TicketDto>;
export type { ContactSettings, BusinessSettingsPatch, TicketSettingsPatch };

export async function configGetBusinessSettings(): Promise<BusinessSettings> {
    const datos = await commands.configGetBusinessSettings();
    return { ...datos, iva_percent: datos.iva_percent ?? 10 };
}

export async function configGetTicketSettings(): Promise<TicketSettings> {
    const datos = await commands.configGetTicketSettings();
    return {
        ...datos,
        margin_top_mm: datos.margin_top_mm ?? 0,
        margin_bottom_mm: datos.margin_bottom_mm ?? 0,
        margin_left_mm: datos.margin_left_mm ?? 0,
        margin_right_mm: datos.margin_right_mm ?? 0,
        font_scale: datos.font_scale ?? 1,
    };
}

export const configGetContactSettings = commands.configGetContactSettings;
export const configPatchBusinessSettings = (patch: BusinessSettingsPatch) => commands.configPatchBusinessSettings({ patch });
export const configPatchTicketSettings = (patch: TicketSettingsPatch) => commands.configPatchTicketSettings({ patch });
export const configPatchContactSettings = (patch: ContactSettingsPatch) => commands.configPatchContactSettings({ patch });
