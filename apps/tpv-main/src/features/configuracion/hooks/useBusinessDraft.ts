// src/features/configuracion/hooks/useBusinessDraft.ts
//
// El borrador de Configuración → Negocio (y del IVA y el mensaje final, que se editan en Ticket y van
// a la misma fila). CFG-INC-01: recuerda sobre qué se tomó (`base`), y lo que llega de otro equipo
// entra en los campos que no se han tocado (`../borrador.ts`).
import { useState } from "react";
import type { BusinessDraft } from "../types";
import { BUSINESS_DRAFT_CAMPOS } from "../types";
import { cambiosDe, camposDistintos, rebasarBorrador, type Choques } from "../borrador";
import { leerIva } from "../../../shared/lib/iva";

function draftDe(biz: BusinessDraft): BusinessDraft {
    return {
        business_name: biz.business_name,
        logo_data_url: biz.logo_data_url,
        direccion: biz.direccion,
        telefono: biz.telefono,
        cif: biz.cif,
        mensaje_footer: biz.mensaje_footer,
        iva_percent: biz.iva_percent,
        razon_social: biz.razon_social,
    };
}

type Estado = {
    /** Lo guardado cuando se tomó el borrador: con esto se sabe qué se ha tocado aquí. */
    base: BusinessDraft;
    draft: BusinessDraft;
    /**
     * Lo tecleado en el campo del IVA, tal cual. El borrador guarda el número, y sólo cambia cuando
     * lo tecleado es un tipo válido (RI-78).
     */
    ivaTexto: string;
    choques: Choques<BusinessDraft>;
};

function estadoDe(actual: BusinessDraft): Estado {
    return { base: actual, draft: actual, ivaTexto: String(actual.iva_percent), choques: {} };
}

/** ¿Se ha tocado aquí el IVA? Lo tecleado no es el de la base, también si no es un número. */
function ivaTocado(e: Pick<Estado, "base" | "ivaTexto">): boolean {
    return leerIva(e.ivaTexto) !== e.base.iva_percent;
}

/**
 * El borrador tras llegar `fresco`. Un IVA a medio escribir («2», «10,») cuenta como tocado: no se
 * cambia por el que llega de fuera.
 */
function rebasar(e: Estado, fresco: BusinessDraft): Estado {
    const tocadoIva = ivaTocado(e);
    const { borrador, choques } = rebasarBorrador(e.draft, e.base, fresco, BUSINESS_DRAFT_CAMPOS, e.choques, (k) =>
        k === "iva_percent" ? tocadoIva : e.draft[k] !== e.base[k],
    );
    if (tocadoIva) {
        // Con un texto que no es número el borrador conserva el último válido: el choque se mira
        // contra lo tecleado.
        delete choques.iva_percent;
        if (fresco.iva_percent !== e.base.iva_percent && leerIva(e.ivaTexto) !== fresco.iva_percent) {
            choques.iva_percent = fresco.iva_percent;
        } else if ("iva_percent" in e.choques && leerIva(e.ivaTexto) !== fresco.iva_percent) {
            choques.iva_percent = e.choques.iva_percent;
        }
    }
    return {
        base: fresco,
        draft: borrador,
        ivaTexto: tocadoIva ? e.ivaTexto : String(fresco.iva_percent),
        choques,
    };
}

export function useBusinessDraft(biz: BusinessDraft) {
    const actual = draftDe(biz);
    const [estado, setEstado] = useState<Estado>(() => estadoDe(actual));

    // Lo guardado ha cambiado (otro equipo, la primera lectura o lo que acaba de guardar esta
    // pantalla): se rebasa en el mismo pintado, sin un fotograma con el borrador viejo.
    let e = estado;
    if (camposDistintos(estado.base, actual, BUSINESS_DRAFT_CAMPOS).length > 0) {
        e = rebasar(estado, actual);
        setEstado(e);
    }

    const { base, draft, ivaTexto, choques } = e;
    const dirty = camposDistintos(draft, base, BUSINESS_DRAFT_CAMPOS).length > 0;
    const ivaValido = leerIva(ivaTexto) !== null;

    const setDraft: React.Dispatch<React.SetStateAction<BusinessDraft>> = (accion) =>
        setEstado((s) => ({ ...s, draft: typeof accion === "function" ? accion(s.draft) : accion }));

    /** Vuelve a lo guardado ahora y olvida los avisos. */
    const resetDraft = () => setEstado(estadoDe(actual));

    // IVA desde el campo de texto. RI-78: no se recorta. Antes un «210» tecleado por «21» pasaba a
    // ser 30 delante de quien escribía, y como el campo enseñaba el número ya convertido tampoco se
    // podía teclear un decimal. Lo que no vale se queda en el campo, con su aviso.
    const setIvaFromRaw = (raw: string): void => {
        const n = leerIva(raw);
        setEstado((s) => ({ ...s, ivaTexto: raw, draft: n !== null ? { ...s.draft, iva_percent: n } : s.draft }));
    };

    /** Lo que hay que mandar al guardar: sólo lo que se ha cambiado aquí. */
    const cambios = cambiosDe(draft, base, BUSINESS_DRAFT_CAMPOS);

    // Un aviso sólo mientras el campo siga tocado: si quien edita deja lo que había, ya no hay nada
    // que avisar.
    const choquesVigentes: Choques<BusinessDraft> = {};
    for (const k of Object.keys(choques) as (keyof BusinessDraft)[]) {
        const sigue = k === "iva_percent" ? ivaTocado(e) : draft[k] !== base[k];
        if (sigue) (choquesVigentes as Record<string, unknown>)[k] = choques[k];
    }

    return {
        draft,
        setDraft,
        base,
        dirty,
        cambios,
        choques: choquesVigentes,
        resetDraft,
        setIvaFromRaw,
        ivaTexto,
        ivaValido,
    };
}
