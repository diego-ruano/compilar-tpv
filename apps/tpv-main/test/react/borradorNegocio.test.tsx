/** @vitest-environment jsdom */
// CFG-INC-01: el borrador de Negocio con un cambio de otro equipo entre medias. Lo no tocado toma lo
// nuevo sin contar como «sin guardar», lo tocado se queda, y un campo cambiado en los dos sitios se
// avisa. El IVA a medio escribir tampoco se pisa.
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";

import { useBusinessDraft } from "../../src/features/configuracion/hooks/useBusinessDraft";
import type { BusinessDraft } from "../../src/features/configuracion/types";

const guardado: BusinessDraft = {
    business_name: "Bar La Plaza", logo_data_url: null, direccion: "C/ Mayor 1", telefono: "600000000",
    cif: "B12345674", mensaje_footer: "Gracias", iva_percent: 10, razon_social: "Plaza SL",
};

it("lo de otro equipo entra en lo no tocado, y al guardar va sólo lo cambiado aquí", async () => {
    const { result, rerender } = renderHook((biz: BusinessDraft) => useBusinessDraft(biz), { initialProps: guardado });
    await waitFor(() => expect(result.current.draft.direccion).toBe("C/ Mayor 1"));

    act(() => result.current.setDraft((d) => ({ ...d, direccion: "C/ Nueva 2" })));
    await waitFor(() => expect(result.current.dirty).toBe(true));

    // La Handy cambia el teléfono.
    rerender({ ...guardado, telefono: "699999999" });
    await waitFor(() => expect(result.current.draft.telefono).toBe("699999999"));
    expect(result.current.draft.direccion).toBe("C/ Nueva 2");
    expect(result.current.cambios).toEqual({ direccion: "C/ Nueva 2" });
    expect(result.current.choques).toEqual({});
});

it("un cambio de fuera sin nada tocado aquí no es «sin guardar»", async () => {
    const { result, rerender } = renderHook((biz: BusinessDraft) => useBusinessDraft(biz), { initialProps: guardado });
    rerender({ ...guardado, business_name: "Bar Nuevo" });
    await waitFor(() => expect(result.current.draft.business_name).toBe("Bar Nuevo"));
    expect(result.current.dirty).toBe(false);
    expect(result.current.cambios).toEqual({});
});

it("el mismo campo cambiado en los dos sitios se avisa y se queda lo de aquí", async () => {
    const { result, rerender } = renderHook((biz: BusinessDraft) => useBusinessDraft(biz), { initialProps: guardado });
    act(() => result.current.setDraft((d) => ({ ...d, telefono: "611111111" })));
    await waitFor(() => expect(result.current.dirty).toBe(true));
    rerender({ ...guardado, telefono: "699999999" });
    await waitFor(() => expect(result.current.choques).toEqual({ telefono: "699999999" }));
    expect(result.current.draft.telefono).toBe("611111111");
    expect(result.current.cambios).toEqual({ telefono: "611111111" });

    // Descartar deja lo del otro equipo y quita el aviso.
    act(() => result.current.resetDraft());
    await waitFor(() => expect(result.current.draft.telefono).toBe("699999999"));
    expect(result.current.choques).toEqual({});
    expect(result.current.dirty).toBe(false);
});

it("el IVA sin tocar sigue al de fuera; a medio escribir, se queda", async () => {
    const { result, rerender } = renderHook((biz: BusinessDraft) => useBusinessDraft(biz), { initialProps: guardado });
    rerender({ ...guardado, iva_percent: 21 });
    await waitFor(() => expect(result.current.ivaTexto).toBe("21"));
    expect(result.current.draft.iva_percent).toBe(21);

    act(() => result.current.setIvaFromRaw("4,"));
    await waitFor(() => expect(result.current.ivaTexto).toBe("4,"));
    rerender({ ...guardado, iva_percent: 10 });
    await waitFor(() => expect(result.current.choques).toEqual({ iva_percent: 10 }));
    expect(result.current.ivaTexto).toBe("4,");
});
