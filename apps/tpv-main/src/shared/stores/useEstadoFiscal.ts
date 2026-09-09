// src/shared/stores/useEstadoFiscal.ts
//
// El escalón de la escalera de avisos de Veri*factu (FISCAL-01), disponible en toda la aplicación.
//
// ## Por qué hay un store y no una llamada en cada pantalla
//
// El escalón lo calcula Rust (`escalon_aviso`) sobre la antigüedad del registro **pendiente más
// viejo**, y lo consumen tres sitios muy distintos: el panel de Configuración → Fiscal, el aviso al
// iniciar sesión y el aviso tras cobrar. Tres llamadas independientes darían tres respuestas
// distintas del mismo minuto, y el pulso hay que tenerlo en un sitio.
//
// ## Lo que NO hace
//
// No bloquea nada, y es deliberado: la obligación de remitir es del bar, pero **un TPV que no puede
// cobrar no es una forma de recordárselo**. Lo que esto hace es que no pueda decir que no lo sabía.

import { create } from "zustand";

import { verifactuEstado } from "../../features/configuracion/api/verifactuApis";

/** Los peldaños, tal como los nombra `tpv_infra_sqlite::verifactu::escalon_aviso`. */
export type EscalonFiscal =
    | "ninguno"
    | "visible"
    | "notificacion"
    | "modal_login"
    | "modal_cobro";

const ORDEN: EscalonFiscal[] = [
    "ninguno",
    "visible",
    "notificacion",
    "modal_login",
    "modal_cobro",
];

/** ¿`a` es al menos tan grave como `b`? */
export function alMenos(a: EscalonFiscal, b: EscalonFiscal): boolean {
    return ORDEN.indexOf(a) >= ORDEN.indexOf(b);
}

/** Cada cuánto se vuelve a preguntar. La cola crece con cada cobro y se vacía con cada envío. */
const REFRESCO_MS = 2 * 60 * 1000;

type Estado = {
    escalon: EscalonFiscal;
    antiguedadMin: number | null;
    pendientes: number;
    /** `false` hasta la primera respuesta. Sin esto, el aviso parpadearía al arrancar. */
    listo: boolean;
    /**
     * El aviso de inicio de sesión ya se ha reconocido en esta sesión.
     *
     * Vive en memoria y no en `localStorage` a propósito: lo que se reconoce es «lo he visto hoy»,
     * no «no me lo vuelvas a enseñar nunca». Al volver a entrar, vuelve a salir — que es el punto.
     */
    reconocido: boolean;

    init: () => void;
    refrescar: () => Promise<void>;
    reconocer: () => void;
};

let timer: number | null = null;
let iniciado = false;

export const useEstadoFiscal = create<Estado>((set, get) => ({
    escalon: "ninguno",
    antiguedadMin: null,
    pendientes: 0,
    listo: false,
    reconocido: false,

    init: () => {
        if (iniciado) return;
        iniciado = true;

        void get().refrescar();
        timer = window.setInterval(() => void get().refrescar(), REFRESCO_MS);

        // El job de remisión avisa al mover la cola, así que al bajar el escalón se nota enseguida y
        // no al cabo de dos minutos.
        void import("@tauri-apps/api/event").then(({ listen }) =>
            listen("verifactu:cambio", () => void get().refrescar()),
        );
    },

    refrescar: async () => {
        try {
            const e = await verifactuEstado();
            const escalon = (e.escalon_aviso ?? "ninguno") as EscalonFiscal;
            const antes = get().escalon;
            set({
                escalon: ORDEN.includes(escalon) ? escalon : "ninguno",
                antiguedadMin: e.antiguedad_pendiente_min ?? null,
                pendientes: Number(e.pendientes ?? 0),
                listo: true,
                // Si el escalón SUBE, el reconocimiento anterior ya no vale: lo que se reconoció era
                // un problema más pequeño. Y si baja, da igual: el aviso deja de salir.
                reconocido: alMenos(escalon, antes) && escalon !== antes ? false : get().reconocido,
            });
        } catch {
            // Una Handy no tiene registros de facturación y este comando falla ahí. No es un error
            // que haya que enseñar: simplemente no hay escalera que subir.
            set({ listo: true });
        }
    },

    reconocer: () => set({ reconocido: true }),
}));

/** Para los tests y para un cierre de sesión: deja el store como recién cargado. */
export function _resetEstadoFiscal(): void {
    if (timer !== null) window.clearInterval(timer);
    timer = null;
    iniciado = false;
    useEstadoFiscal.setState({
        escalon: "ninguno",
        antiguedadMin: null,
        pendientes: 0,
        listo: false,
        reconocido: false,
    });
}
