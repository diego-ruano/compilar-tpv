import { create } from "zustand";
import {
    configGetContactSettings,
    configPatchContactSettings,
    type ContactSettings,
} from "../../features/configuracion/api/configApis";
import { conAviso } from "../lib/conAviso";

const DEFAULTS: ContactSettings = {
    contact_email: "",
    contact_phone: "",
};

type ContactSettingsState = ContactSettings & {
    ready: boolean;
    init: () => Promise<void>;
    limpiarContexto: () => void;
    setMany: (patch: Partial<ContactSettings>) => void;
};

let timer: number | null = null;
let pending: Partial<ContactSettings> = {};
let contexto = 0;

export const useContactSettings = create<ContactSettingsState>((set, get) => ({
    ...DEFAULTS,
    ready: false,

    init: async () => {
        const vigente = contexto;
        try {
            const s = await configGetContactSettings();
            if (vigente !== contexto) return;
            set({ ...DEFAULTS, ...s, ready: true });
        } catch (e) {
            if (vigente !== contexto) return;
            console.error("useContactSettings.init error:", e);
            set({ ...DEFAULTS, ready: true });
        }
    },

    limpiarContexto: () => {
        contexto++;
        if (timer) window.clearTimeout(timer);
        timer = null;
        pending = {};
        set({ ...DEFAULTS, ready: false });
    },

    setMany: (patch) => {
        set({ ...get(), ...patch });
        pending = { ...pending, ...patch };
        if (timer) window.clearTimeout(timer);
        // Autoguardado sin rollback, pero el fallo se avisa (ver useBusinessSettings).
        timer = window.setTimeout(
            conAviso(async () => {
                const toSave = pending;
                pending = {};
                timer = null;
                await configPatchContactSettings(toSave);
            }, "No se han podido guardar los datos de contacto"),
            400,
        );
    },
}));
