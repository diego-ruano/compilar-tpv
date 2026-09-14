// src/shared/stores/useBusinessSettings.ts
import { create } from "zustand";
import {
    configGetBusinessSettings,
    configPatchBusinessSettings,
    type BusinessSettings,
} from "../../features/configuracion/api/configApis";
import { conAviso } from "../lib/conAviso";

const DEFAULTS: BusinessSettings = {
    businessName: "TPV",
    logoDataUrl: null,
    direccion: "",
    telefono: "",
    cif: "",
    mensajeFooter: "¡Gracias por su visita!",
    ivaPercent: 10,
    // FISCAL-01. `razonSocial` arranca VACÍA a propósito: no hay defecto razonable para quién
    // factura, y que esté vacía es precisamente lo que impide cobrar hasta que alguien la escriba.
    razonSocial: "",
    descripcionOp: "Servicios de hosteleria y restauracion",
    limiteSimplif: 3000,
    verifactuEntorno: "produccion",
};

type BusinessSettingsState = BusinessSettings & {
    ready: boolean;
    init: () => Promise<void>;

    // UI instantánea + autoguardado
    setMany: (patch: Partial<BusinessSettings>) => void;

    // opcionales (por comodidad)
    setBusinessName: (v: string) => void;
    setLogoDataUrl: (v: string | null) => void;
    setDireccion: (v: string) => void;
    setTelefono: (v: string) => void;
    setCif: (v: string) => void;
    setMensajeFooter: (v: string) => void;
    setIvaPercent: (v: number) => void;
    setRazonSocial: (v: string) => void;
};

// debounce (module-level)
let timer: number | null = null;
let pending: Partial<BusinessSettings> = {};

function clampIva(n: number) {
    if (!Number.isFinite(n)) return DEFAULTS.ivaPercent;
    return Math.max(0, Math.min(30, n));
}

export const useBusinessSettings = create<BusinessSettingsState>(
    (set, get) => ({
        ...DEFAULTS,
        ready: false,

        init: async () => {
            try {
                const s = await configGetBusinessSettings();
                set({
                    ...DEFAULTS,
                    ...s,
                    ivaPercent: clampIva(s.ivaPercent),
                    ready: true,
                });
            } catch (e) {
                console.error("useBusinessSettings.init error:", e);
                set({ ...DEFAULTS, ready: true });
            }
        },

        setMany: (patch) => {
            // Normaliza IVA si viene
            const nextPatch: Partial<BusinessSettings> = { ...patch };
            if ("ivaPercent" in nextPatch && nextPatch.ivaPercent != null) {
                nextPatch.ivaPercent = clampIva(Number(nextPatch.ivaPercent));
            }

            // 1) UI instantánea
            set({ ...get(), ...nextPatch });

            // 2) acumular patch para DB
            pending = { ...pending, ...nextPatch };

            // 3) debounce write. Sin rollback —es autoguardado y la UI no debe dar saltos—, pero el
            // fallo se AVISA: antes sólo iba a la consola, y un ajuste que parece guardado y no lo
            // está se descubre mucho después (el guardado exige Administrador, por ejemplo).
            if (timer) window.clearTimeout(timer);
            timer = window.setTimeout(
                conAviso(async () => {
                    const toSave = pending;
                    pending = {};
                    timer = null;
                    await configPatchBusinessSettings(toSave);
                }, "No se han podido guardar los datos del negocio"),
                400,
            );
        },

        setBusinessName: (v) => get().setMany({ businessName: v }),
        setLogoDataUrl: (v) => get().setMany({ logoDataUrl: v }),
        setDireccion: (v) => get().setMany({ direccion: v }),
        setTelefono: (v) => get().setMany({ telefono: v }),
        setCif: (v) => get().setMany({ cif: v }),
        setMensajeFooter: (v) => get().setMany({ mensajeFooter: v }),
        setIvaPercent: (v) => get().setMany({ ivaPercent: clampIva(v) }),
        setRazonSocial: (v) => get().setMany({ razonSocial: v }),
    }),
);
