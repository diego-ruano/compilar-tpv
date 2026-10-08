// src/features/configuracion/hooks/useBusinessDraft.ts
import { useMemo, useState } from "react";
import type { BusinessDraft } from "../types";
import { shallowEqualDraft } from "../types";
import { clampIva } from "../utils";

type BizLike = {
    business_name: string;
    logo_data_url: string | null;
    direccion: string;
    telefono: string;
    cif: string;
    mensaje_footer: string;
    iva_percent: number;
    razon_social: string;
};

export function useBusinessDraft(biz: BizLike) {
    // 1) draft local inicial (copia del store)
    const [draft, setDraft] = useState<BusinessDraft>(() => ({
        business_name: biz.business_name,
        logo_data_url: biz.logo_data_url,
        direccion: biz.direccion,
        telefono: biz.telefono,
        cif: biz.cif,
        mensaje_footer: biz.mensaje_footer,
        iva_percent: biz.iva_percent,
        razon_social: biz.razon_social,
    }));

    // 2) comparo contra estado actual del store (SIN hidratar)
    const dirty = useMemo(() => {
        const current: BusinessDraft = {
            business_name: biz.business_name,
            logo_data_url: biz.logo_data_url,
            direccion: biz.direccion,
            telefono: biz.telefono,
            cif: biz.cif,
            mensaje_footer: biz.mensaje_footer,
            iva_percent: biz.iva_percent,
            razon_social: biz.razon_social,
        };
        return !shallowEqualDraft(draft, current);
    }, [
        draft,
        biz.business_name,
        biz.logo_data_url,
        biz.direccion,
        biz.telefono,
        biz.cif,
        biz.mensaje_footer,
        biz.iva_percent,
        biz.razon_social,
    ]);

    // 3) reset a lo que haya ahora en el store
    const resetDraft = () => {
        setDraft({
            business_name: biz.business_name,
            logo_data_url: biz.logo_data_url,
            direccion: biz.direccion,
            telefono: biz.telefono,
            cif: biz.cif,
            mensaje_footer: biz.mensaje_footer,
            iva_percent: biz.iva_percent,
            razon_social: biz.razon_social,
        });
    };

    // 4) IVA desde input string
    const setIvaFromRaw = (raw: string): void => {
        const n = Number(String(raw).replace(",", "."));
        setDraft((d) => ({
            ...d,
            iva_percent: clampIva(Number.isFinite(n) ? n : 0),
        }));
    };

    return { draft, setDraft, dirty, resetDraft, setIvaFromRaw };
}
