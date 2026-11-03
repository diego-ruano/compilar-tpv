import { create } from "zustand";
import {
    configGetContactSettings,
    configPatchContactSettings,
    type ContactSettings,
} from "../../features/configuracion/api/configApis";
import { conAviso } from "../lib/conAviso";
import { captureException } from "../observability/sentry";

const DEFAULTS: ContactSettings = {
    contact_email: "",
    contact_phone: "",
};

type ContactSettingsState = ContactSettings & {
    ready: boolean;
    init: () => Promise<void>;
    limpiarContexto: () => void;
    setMany: (patch: Partial<ContactSettings>) => void;
    /** Escribe ya y falla si no se guarda (ver `guardarYa` en useBusinessSettings). */
    guardarYa: () => Promise<void>;
};

let timer: number | null = null;
let pending: Partial<ContactSettings> = {};
let contexto = 0;

/** Escribe ya lo acumulado y cancela la escritura con retardo. Sin nada pendiente, no hace nada. */
async function escribirPendiente(): Promise<void> {
    if (timer) window.clearTimeout(timer);
    timer = null;
    const toSave = pending;
    pending = {};
    if (Object.keys(toSave).length) await configPatchContactSettings(toSave);
}

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
            captureException(e, { fase: "ajustes_contacto" });
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
            conAviso(escribirPendiente, "No se han podido guardar los datos de contacto"),
            400,
        );
    },

    guardarYa: async () => {
        try {
            await escribirPendiente();
        } catch (e) {
            void get().init();
            throw e;
        }
    },
}));
