// src/shared/stores/useBusinessSettings.ts
import { create } from "zustand";
import {
    configGetBusinessSettings,
    configPatchBusinessSettings,
    type BusinessSettings,
} from "../../features/configuracion/api/configApis";
import { conAviso } from "../lib/conAviso";
import { deCentimos } from "../lib/dinero";

const DEFAULTS: BusinessSettings = {
    business_name: "TPV",
    logo_data_url: null,
    direccion: "",
    telefono: "",
    cif: "",
    mensaje_footer: "¡Gracias por su visita!",
    iva_percent: 10,
    umbral_descuadre: deCentimos(500),
    // FISCAL-01. `razon_social` arranca VACÍA a propósito: no hay defecto razonable para quién
    // factura, y que esté vacía es precisamente lo que impide cobrar hasta que alguien la escriba.
    razon_social: "",
    descripcion_op: "Servicios de hosteleria y restauracion",
    limite_simplif: deCentimos(300_000),
    verifactu_entorno: "produccion",
    // RI-61: los mismos valores por defecto que el esquema.
    reserva_duracion_min: 120,
    reserva_solape: "avisar",
};

type BusinessSettingsState = BusinessSettings & {
    ready: boolean;
    init: () => Promise<void>;
    limpiarContexto: () => void;

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
let contexto = 0;

export const useBusinessSettings = create<BusinessSettingsState>(
    (set, get) => ({
        ...DEFAULTS,
        ready: false,

        init: async () => {
            const vigente = contexto;
            try {
                const s = await configGetBusinessSettings();
                if (vigente !== contexto) return;
                set({ ...DEFAULTS, ...s, ready: true });
            } catch (e) {
                if (vigente !== contexto) return;
                console.error("useBusinessSettings.init error:", e);
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
            // RI-78: el IVA no se recorta aquí. Lo valida el formulario antes de llegar y lo
            // rechaza el backend; recortarlo guardaba un tipo que nadie había escrito.
            const nextPatch: Partial<BusinessSettings> = { ...patch };

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

        setBusinessName: (v) => get().setMany({ business_name: v }),
        setLogoDataUrl: (v) => get().setMany({ logo_data_url: v }),
        setDireccion: (v) => get().setMany({ direccion: v }),
        setTelefono: (v) => get().setMany({ telefono: v }),
        setCif: (v) => get().setMany({ cif: v }),
        setMensajeFooter: (v) => get().setMany({ mensaje_footer: v }),
        setIvaPercent: (v) => get().setMany({ iva_percent: v }),
        setRazonSocial: (v) => get().setMany({ razon_social: v }),
    }),
);
