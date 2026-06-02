// src/components/configuracion/hooks/useBusinessDraft.ts
import { useMemo, useState } from "react";
import type { BusinessDraft } from "../types";
import { shallowEqualDraft } from "../types";
import { clampIva } from "../utils";

type BizLike = {
    businessName: string;
    logoDataUrl: string | null;
    direccion: string;
    telefono: string;
    cif: string;
    mensajeFooter: string;
    ivaPercent: number;
};

export function useBusinessDraft(biz: BizLike) {
    // 1) draft local inicial (copia del store)
    const [draft, setDraft] = useState<BusinessDraft>(() => ({
        businessName: biz.businessName,
        logoDataUrl: biz.logoDataUrl,
        direccion: biz.direccion,
        telefono: biz.telefono,
        cif: biz.cif,
        mensajeFooter: biz.mensajeFooter,
        ivaPercent: biz.ivaPercent,
    }));

    // 2) comparo contra estado actual del store (SIN hidratar)
    const dirty = useMemo(() => {
        const current: BusinessDraft = {
            businessName: biz.businessName,
            logoDataUrl: biz.logoDataUrl,
            direccion: biz.direccion,
            telefono: biz.telefono,
            cif: biz.cif,
            mensajeFooter: biz.mensajeFooter,
            ivaPercent: biz.ivaPercent,
        };
        return !shallowEqualDraft(draft, current);
    }, [
        draft,
        biz.businessName,
        biz.logoDataUrl,
        biz.direccion,
        biz.telefono,
        biz.cif,
        biz.mensajeFooter,
        biz.ivaPercent,
    ]);

    // 3) reset a lo que haya ahora en el store
    const resetDraft = () => {
        setDraft({
            businessName: biz.businessName,
            logoDataUrl: biz.logoDataUrl,
            direccion: biz.direccion,
            telefono: biz.telefono,
            cif: biz.cif,
            mensajeFooter: biz.mensajeFooter,
            ivaPercent: biz.ivaPercent,
        });
    };

    // 4) IVA desde input string
    const setIvaFromRaw = (raw: string): void => {
        const n = Number(String(raw).replace(",", "."));
        setDraft((d) => ({
            ...d,
            ivaPercent: clampIva(Number.isFinite(n) ? n : 0),
        }));
    };

    return { draft, setDraft, dirty, resetDraft, setIvaFromRaw };
}
