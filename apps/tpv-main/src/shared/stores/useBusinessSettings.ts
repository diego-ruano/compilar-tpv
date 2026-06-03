// src/shared/stores/useBusinessSettings.ts
import { create } from "zustand";
import {
    configGetBusinessSettings,
    configPatchBusinessSettings,
    type BusinessSettings,
} from "../../components/configuracion/api/configApis";

const DEFAULTS: BusinessSettings = {
    businessName: "TPV",
    logoDataUrl: null,
    direccion: "",
    telefono: "",
    cif: "",
    mensajeFooter: "¡Gracias por su visita!",
    ivaPercent: 10,
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

            // 3) debounce write
            if (timer) window.clearTimeout(timer);
            timer = window.setTimeout(async () => {
                const toSave = pending;
                pending = {};
                timer = null;

                try {
                    await configPatchBusinessSettings(toSave);
                } catch (e) {
                    console.error("Business_Settings save error:", e);
                    // No rollback: autoguardado => mejor no “saltos” en UI.
                    // (si quieres, puedes mostrar toast)
                }
            }, 400);
        },

        setBusinessName: (v) => get().setMany({ businessName: v }),
        setLogoDataUrl: (v) => get().setMany({ logoDataUrl: v }),
        setDireccion: (v) => get().setMany({ direccion: v }),
        setTelefono: (v) => get().setMany({ telefono: v }),
        setCif: (v) => get().setMany({ cif: v }),
        setMensajeFooter: (v) => get().setMany({ mensajeFooter: v }),
        setIvaPercent: (v) => get().setMany({ ivaPercent: clampIva(v) }),
    }),
);
