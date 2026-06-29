import { create } from "zustand";
import {
    configGetContactSettings,
    configPatchContactSettings,
    type ContactSettings,
} from "../../features/configuracion/api/configApis";

const DEFAULTS: ContactSettings = {
    recoveryEmail: "",
    contactEmail: "",
    contactPhone: "",
};

type ContactSettingsState = ContactSettings & {
    ready: boolean;
    init: () => Promise<void>;
    setMany: (patch: Partial<ContactSettings>) => void;
};

let timer: number | null = null;
let pending: Partial<ContactSettings> = {};

export const useContactSettings = create<ContactSettingsState>((set, get) => ({
    ...DEFAULTS,
    ready: false,

    init: async () => {
        try {
            const s = await configGetContactSettings();
            set({ ...DEFAULTS, ...s, ready: true });
        } catch (e) {
            console.error("useContactSettings.init error:", e);
            set({ ...DEFAULTS, ready: true });
        }
    },

    setMany: (patch) => {
        set({ ...get(), ...patch });
        pending = { ...pending, ...patch };
        if (timer) window.clearTimeout(timer);
        timer = window.setTimeout(async () => {
            const toSave = pending;
            pending = {};
            timer = null;
            try {
                await configPatchContactSettings(toSave);
            } catch (e) {
                console.error("Contact_Settings save error:", e);
            }
        }, 400);
    },
}));
