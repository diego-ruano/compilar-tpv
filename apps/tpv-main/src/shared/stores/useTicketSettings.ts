// src/shared/stores/useTicketSettings.ts
import { create } from "zustand";
import {
    configGetTicketSettings,
    configPatchTicketSettings,
    type TicketSettings,
} from "../../features/configuracion/api/configApis";

const DEFAULTS: TicketSettings = {
    showLogo: true,
    showBusinessName: true,
    showAddress: true,
    showPhone: true,
    showCif: true,
    showDateTime: true,
    showLineItems: true,
    showBaseAndIva: true,
    showTotal: true,
    showFooterMessage: true,

    // ✅ NUEVO (schema): ancho del papel en mm
    paperWidthMm: 80,

    // Parámetros finos de impresión (respetados por el renderizado ESC/POS).
    paperDpi: 203,
    charsPerLine: 42,
    marginTopMm: 0,
    marginBottomMm: 0,
    marginLeftMm: 0,
    marginRightMm: 0,
    fontScale: 1,
};

type TicketSettingsState = {
    settings: TicketSettings;
    ready: boolean;
    init: () => Promise<void>;

    // UI instantánea + autoguardado
    setSetting: <K extends keyof TicketSettings>(
        key: K,
        value: TicketSettings[K],
    ) => void;
    setAll: (next: TicketSettings) => void;
    reset: () => void;
};

// debounce (module-level)
let timer: number | null = null;
let pending: Partial<TicketSettings> = {};

function clampPaperWidthMm(n: number) {
    return n === 58 || n === 80 || n === 112 ? n : 80;
}

function sanitizePatch(p: Partial<TicketSettings>): Partial<TicketSettings> {
    // Asegura que si llega paperWidthMm, vaya normalizado
    if ("paperWidthMm" in p && p.paperWidthMm != null) {
        return {
            ...p,
            paperWidthMm: clampPaperWidthMm(Number(p.paperWidthMm)),
        };
    }
    return p;
}

function scheduleFlush() {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(async () => {
        const toSave = pending;
        pending = {};
        timer = null;

        try {
            await configPatchTicketSettings(toSave);
        } catch (e) {
            console.error("Ticket_Settings save error:", e);
        }
    }, 250);
}

export const useTicketSettings = create<TicketSettingsState>((set, get) => ({
    settings: DEFAULTS,
    ready: false,

    init: async () => {
        try {
            const s = await configGetTicketSettings();

            // ✅ merge + saneado
            const merged: TicketSettings = {
                ...DEFAULTS,
                ...s,
                paperWidthMm: clampPaperWidthMm(
                    Number((s as any)?.paperWidthMm ?? DEFAULTS.paperWidthMm),
                ),
            };

            set({ settings: merged, ready: true });
        } catch (e) {
            console.error("useTicketSettings.init error:", e);
            set({ settings: DEFAULTS, ready: true });
        }
    },

    setSetting: (key, value) => {
        // 1) UI instantánea
        const cur = get().settings;
        const next = { ...cur, [key]: value } as TicketSettings;

        // normaliza el ancho si es ese campo
        if (key === "paperWidthMm") {
            next.paperWidthMm = clampPaperWidthMm(Number(value));
        }

        set({ settings: next });

        // 2) patch acumulado
        pending = sanitizePatch({
            ...pending,
            [key]: value,
        } as Partial<TicketSettings>);

        // 3) debounce write
        scheduleFlush();
    },

    setAll: (next) => {
        const merged: TicketSettings = {
            ...DEFAULTS,
            ...next,
            paperWidthMm: clampPaperWidthMm(
                Number((next as any)?.paperWidthMm ?? DEFAULTS.paperWidthMm),
            ),
        };

        set({ settings: merged });

        // guarda todo (con debounce igual)
        pending = sanitizePatch({ ...pending, ...merged });

        scheduleFlush();
    },

    reset: () => {
        set({ settings: DEFAULTS });

        pending = sanitizePatch({ ...pending, ...DEFAULTS });

        scheduleFlush();
    },
}));
