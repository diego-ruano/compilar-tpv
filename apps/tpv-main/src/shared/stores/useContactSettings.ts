import { create } from "zustand";
import {
    configGetContactSettings,
    configPatchContactSettings,
    type ContactSettings,
} from "../../features/configuracion/api/configApis";
import { conAviso } from "../lib/conAviso";
import { captureException } from "../observability/sentry";
import { toAppError } from "@tpv/client";

const DEFAULTS: ContactSettings = {
    contact_email: "",
    contact_phone: "",
};

type ContactSettingsState = ContactSettings & {
    ready: boolean;
    /**
     * CFG-INC-02: por qué no se han podido leer, o `null`. Sin una lectura buena `ready` sigue en
     * `false`: antes se ponían los valores por defecto como si fueran los guardados, y la pantalla
     * dejaba guardarlos encima de los buenos. Si falla una relectura se conservan los últimos
     * leídos, y esto dice que pueden no ser los de ahora.
     */
    error: string | null;
    init: () => Promise<void>;
    limpiarContexto: () => void;
    setMany: (patch: Partial<ContactSettings>) => void;
    /** Escribe ya y falla si no se guarda (ver `guardarYa` en useBusinessSettings). */
    guardarYa: () => Promise<void>;
    /** Guarda sólo estos campos, ya, y los pone en el store cuando están guardados (CFG-INC-01). */
    guardar: (patch: Partial<ContactSettings>) => Promise<void>;
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
    error: null,

    init: async () => {
        const vigente = contexto;
        try {
            const s = await configGetContactSettings();
            if (vigente !== contexto) return;
            set({ ...DEFAULTS, ...s, ready: true, error: null });
        } catch (e) {
            if (vigente !== contexto) return;
            captureException(e, { fase: "ajustes_contacto" });
            set({ error: toAppError(e).message });
        }
    },

    limpiarContexto: () => {
        contexto++;
        if (timer) window.clearTimeout(timer);
        timer = null;
        pending = {};
        set({ ...DEFAULTS, ready: false, error: null });
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

    guardar: async (patch) => {
        if (!Object.keys(patch).length) return;
        const vigente = contexto;
        pending = { ...pending, ...patch };
        await get().guardarYa();
        if (vigente === contexto) set(patch);
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
