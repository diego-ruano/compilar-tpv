// CFG-INC-01: guardar «Negocio» pisaba lo que otro equipo acababa de cambiar. El borrador se copiaba
// del store una vez, «sin guardar» se comparaba con el store vivo y al guardar se mandaban todos los
// campos. Ahora el borrador recuerda su base, lo de fuera entra en lo no tocado y se manda sólo lo
// cambiado.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cambiosDe, rebasarBorrador } from "../src/features/configuracion/borrador";

type F = { nombre: string; telefono: string; direccion: string };
const CAMPOS = ["nombre", "telefono", "direccion"] as const;
const base: F = { nombre: "Bar", telefono: "600", direccion: "C/ Mayor" };

describe("el borrador frente a lo que llega de otro equipo", () => {
    it("lo no tocado toma lo nuevo y lo tocado se queda", () => {
        const borrador = { ...base, direccion: "C/ Nueva 1" };
        const fresco = { ...base, telefono: "699" };
        const r = rebasarBorrador(borrador, base, fresco, CAMPOS);
        expect(r.borrador).toEqual({ nombre: "Bar", telefono: "699", direccion: "C/ Nueva 1" });
        expect(r.choques).toEqual({});
        // Sobre la base nueva, lo único cambiado aquí es la dirección.
        expect(cambiosDe(r.borrador, fresco, CAMPOS)).toEqual({ direccion: "C/ Nueva 1" });
    });

    it("un campo tocado que también cambió fuera se avisa, y se queda lo de aquí", () => {
        const borrador = { ...base, telefono: "611" };
        const fresco = { ...base, telefono: "699" };
        const r = rebasarBorrador(borrador, base, fresco, CAMPOS);
        expect(r.borrador.telefono).toBe("611");
        expect(r.choques).toEqual({ telefono: "699" });
        // Con otra llegada que no toca el teléfono, el aviso sigue.
        const otra = rebasarBorrador(r.borrador, fresco, { ...fresco, nombre: "Bar 2" }, CAMPOS, r.choques);
        expect(otra.choques).toEqual({ telefono: "699" });
        expect(otra.borrador.nombre).toBe("Bar 2");
    });

    it("si fuera pusieron lo mismo que aquí, no hay nada que avisar", () => {
        const borrador = { ...base, telefono: "699" };
        const r = rebasarBorrador(borrador, base, { ...base, telefono: "699" }, CAMPOS);
        expect(r.choques).toEqual({});
        expect(cambiosDe(r.borrador, { ...base, telefono: "699" }, CAMPOS)).toEqual({});
    });
});

const h = vi.hoisted(() => ({ business: vi.fn(), patchBusiness: vi.fn(), contact: vi.fn(), patchContact: vi.fn() }));
vi.mock("../src/features/configuracion/api/configApis", () => ({
    configGetBusinessSettings: h.business, configPatchBusinessSettings: h.patchBusiness,
    configGetContactSettings: h.contact, configPatchContactSettings: h.patchContact,
    configGetTicketSettings: vi.fn(), configPatchTicketSettings: vi.fn(),
}));
const { useBusinessSettings } = await import("../src/shared/stores/useBusinessSettings");
const { useContactSettings } = await import("../src/shared/stores/useContactSettings");

describe("guardar sólo lo cambiado", () => {
    beforeEach(() => {
        vi.stubGlobal("window", { setTimeout, clearTimeout });
        vi.resetAllMocks();
        useBusinessSettings.getState().limpiarContexto();
        useContactSettings.getState().limpiarContexto();
    });

    it("el negocio manda sólo esos campos y los pone en el store al guardarse", async () => {
        h.business.mockResolvedValue({ business_name: "Bar", telefono: "699", iva_percent: 10 });
        await useBusinessSettings.getState().init();
        h.patchBusiness.mockResolvedValue(undefined);
        await useBusinessSettings.getState().guardar({ direccion: "C/ Nueva 1" });
        expect(h.patchBusiness).toHaveBeenCalledTimes(1);
        expect(h.patchBusiness).toHaveBeenCalledWith({ direccion: "C/ Nueva 1" });
        expect(useBusinessSettings.getState().direccion).toBe("C/ Nueva 1");
        expect(useBusinessSettings.getState().telefono).toBe("699");
    });

    it("si no se guarda, el store no enseña como guardado lo que no lo está", async () => {
        h.business.mockResolvedValue({ business_name: "Bar", direccion: "C/ Mayor", iva_percent: 10 });
        await useBusinessSettings.getState().init();
        h.patchBusiness.mockRejectedValue(new Error("sin permiso"));
        await expect(useBusinessSettings.getState().guardar({ direccion: "C/ Nueva 1" })).rejects.toThrow("sin permiso");
        expect(useBusinessSettings.getState().direccion).toBe("C/ Mayor");
    });

    it("el correo de contacto, igual", async () => {
        h.contact.mockResolvedValue({ contact_email: "a@ejemplo.test", contact_phone: "600" });
        await useContactSettings.getState().init();
        h.patchContact.mockResolvedValue(undefined);
        await useContactSettings.getState().guardar({ contact_email: "b@ejemplo.test" });
        expect(h.patchContact).toHaveBeenCalledWith({ contact_email: "b@ejemplo.test" });
        expect(useContactSettings.getState().contact_email).toBe("b@ejemplo.test");
    });
});
