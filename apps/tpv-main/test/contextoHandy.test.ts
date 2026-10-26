import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ business: vi.fn(), ticket: vi.fn(), contact: vi.fn(), patchBusiness: vi.fn(), patchTicket: vi.fn(), patchContact: vi.fn() }));
vi.mock("../src/features/configuracion/api/configApis", () => ({
    configGetBusinessSettings: h.business, configGetTicketSettings: h.ticket, configGetContactSettings: h.contact,
    configPatchBusinessSettings: h.patchBusiness, configPatchTicketSettings: h.patchTicket, configPatchContactSettings: h.patchContact,
}));
import { useBusinessSettings } from "../src/shared/stores/useBusinessSettings";
import { useTicketSettings } from "../src/shared/stores/useTicketSettings";
import { useContactSettings } from "../src/shared/stores/useContactSettings";
const casos = [
    { nombre: "negocio", api: h.business, patch: h.patchBusiness, store: useBusinessSettings,
        datoA: {business_name: "A", iva_percent: 10}, datoB: {business_name: "B", iva_percent: 10}, valor: () => useBusinessSettings.getState().business_name,
        mutar: () => useBusinessSettings.getState().setMany({business_name: "A"}) },
    { nombre: "ticket", api: h.ticket, patch: h.patchTicket, store: useTicketSettings,
        datoA: {paper_width_mm: 58}, datoB: {paper_width_mm: 112}, valor: () => useTicketSettings.getState().settings.paper_width_mm,
        mutar: () => useTicketSettings.getState().setSetting("paper_width_mm", 58) },
    { nombre: "contacto", api: h.contact, patch: h.patchContact, store: useContactSettings,
        datoA: {contact_email: "a@ejemplo.test"}, datoB: {contact_email: "b@ejemplo.test"}, valor: () => useContactSettings.getState().contact_email,
        mutar: () => useContactSettings.getState().setMany({contact_email: "a@ejemplo.test"}) },
];
beforeEach(() => {
    vi.useFakeTimers(); vi.stubGlobal("window", {setTimeout, clearTimeout}); vi.resetAllMocks();
    for (const caso of casos) caso.store.getState().limpiarContexto();
});
afterEach(() => { for (const caso of casos) caso.store.getState().limpiarContexto(); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("cambiar de negocio con ajustes pendientes", () => {
    it.each(casos)("una lectura tardía de $nombre no sustituye los valores del nuevo negocio", async ({api, store, datoA, datoB, valor}) => {
        let resolver!: (dato: unknown) => void;
        api.mockReturnValueOnce(new Promise((resolve) => { resolver = resolve; })).mockResolvedValue(datoB);
        const anterior = store.getState().init();
        store.getState().limpiarContexto(); await store.getState().init();
        const esperado = valor(); resolver(datoA); await anterior;
        expect(valor()).toBe(esperado); expect(store.getState().ready).toBe(true);
    });
    it.each(casos)("cancela el autoguardado de $nombre que pertenecía al vínculo anterior", async ({store, mutar, patch}) => {
        mutar(); store.getState().limpiarContexto(); await vi.runAllTimersAsync();
        expect(patch).not.toHaveBeenCalled(); expect(store.getState().ready).toBe(false);
    });
});
describe("guardar con el botón «Guardar»", () => {
    const conBoton = [
        { nombre: "negocio", api: h.business, patch: h.patchBusiness, mutar: casos[0].mutar, guardarYa: () => useBusinessSettings.getState().guardarYa(),
            guardado: {business_name: "B", iva_percent: 10}, valor: () => useBusinessSettings.getState().business_name },
        { nombre: "contacto", api: h.contact, patch: h.patchContact, mutar: casos[2].mutar, guardarYa: () => useContactSettings.getState().guardarYa(),
            guardado: {contact_email: "b@ejemplo.test"}, valor: () => useContactSettings.getState().contact_email },
    ];
    it.each(conBoton)("$nombre se escribe sin esperar al autoguardado, y una sola vez", async ({patch, mutar, guardarYa}) => {
        patch.mockResolvedValue(undefined);
        mutar(); await guardarYa();
        expect(patch).toHaveBeenCalledTimes(1);
        await vi.runAllTimersAsync(); expect(patch).toHaveBeenCalledTimes(1);
    });
    it.each(conBoton)("si $nombre no se guarda, falla y se vuelve a leer lo guardado", async ({api, patch, mutar, guardarYa, guardado, valor}) => {
        patch.mockRejectedValue(new Error("sin permiso")); api.mockResolvedValue(guardado);
        mutar(); await expect(guardarYa()).rejects.toThrow("sin permiso");
        await vi.runAllTimersAsync();
        expect(valor()).toBe(Object.values(guardado)[0]);
    });
});
