// src/features/configuracion/hooks/useBusinessDraft.ts
import { useMemo, useState } from "react";
import type { BusinessDraft } from "../types";
import { shallowEqualDraft } from "../types";
import { leerIva } from "../../../shared/lib/iva";

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

    // Lo tecleado en el campo del IVA, tal cual. El borrador guarda el número, y sólo cambia
    // cuando lo tecleado es un tipo válido.
    const [ivaTexto, setIvaTexto] = useState(() => String(biz.iva_percent));
    const ivaValido = leerIva(ivaTexto) !== null;

    // 3) reset a lo que haya ahora en el store
    const resetDraft = () => {
        setIvaTexto(String(biz.iva_percent));
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

    // 4) IVA desde input string. RI-78: no se recorta. Antes un «210» tecleado por «21» pasaba a
    // ser 30 delante de quien escribía, y como el campo enseñaba el número ya convertido tampoco
    // se podía teclear un decimal. Lo que no vale se queda en el campo, con su aviso.
    const setIvaFromRaw = (raw: string): void => {
        setIvaTexto(raw);
        const n = leerIva(raw);
        if (n !== null) setDraft((d) => ({ ...d, iva_percent: n }));
    };

    return { draft, setDraft, dirty, resetDraft, setIvaFromRaw, ivaTexto, ivaValido };
}
