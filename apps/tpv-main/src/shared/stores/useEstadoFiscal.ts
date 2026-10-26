import { commands } from "@tpv/client";
// src/shared/stores/useEstadoFiscal.ts
//
// ¿Puede facturar el negocio? (FISCAL-01), disponible en toda la aplicación.
//
// ## Por qué hay un store y no una llamada en cada pantalla
//
// Lo consumen dos sitios muy distintos: el aviso de que faltan los datos fiscales, que sale delante
// de quien esté, y Configuración → Negocio, que lo refresca al guardar. Con el estado en un sitio,
// guardar los datos quita el aviso en el momento.

import { create } from "zustand";

/** Cada cuánto se vuelve a preguntar. */
const REFRESCO_MS = 2 * 60 * 1000;

type Estado = {
    /**
     * ¿Están el NIF y la razón social del obligado configurados?
     *
     * **Arranca en `true` a propósito.** Es lo contrario de lo que pide la prudencia en casi todo
     * lo demás, y aquí es lo correcto por dos motivos: en una **Handy** este comando falla (no hay
     * registros de facturación allí), y antes de la primera respuesta no se sabe nada. En los dos
     * casos, un `false` sacaría un aviso bloqueante en un equipo que no tiene ese problema. Lo que
     * cubre el lado pesimista ya está donde importa: sin estos datos, `emitir_cobro` corta la
     * transacción del cobro pase lo que pase en la interfaz.
     */
    datosFiscalesCompletos: boolean;
    /** El aviso de los datos que faltan ya se ha visto en esta sesión. */
    datosReconocidos: boolean;
    /** `false` hasta la primera respuesta. Sin esto, el aviso parpadearía al arrancar. */
    listo: boolean;

    init: () => void;
    refrescar: () => Promise<void>;
    reconocerDatos: () => void;
};

let timer: number | null = null;
let iniciado = false;

/**
 * Los valores de partida, en UN solo sitio.
 *
 * Estaban escritos dos veces —en el `create` y en `_resetEstadoFiscal`— y eso no es sólo
 * duplicación: hacía que un test del arranque midiera el reset en vez del store, y por tanto que
 * pasara aunque el defecto de verdad fuera el contrario.
 */
const INICIAL = {
    // `true` al arrancar, al revés que casi todo en este repo, y a propósito (FIS-01): en una Handy
    // el comando que lo comprueba falla —no tiene registros de facturación— y antes de la primera
    // respuesta no se sabe nada. Un `false` sacaría el aviso bloqueante en equipos que no tienen el
    // problema. Lo pesimista ya está donde importa: sin esos datos, el cobro se cancela igual.
    datosFiscalesCompletos: true,
    datosReconocidos: false,
    listo: false,
};

export const useEstadoFiscal = create<Estado>((set, get) => ({
    ...INICIAL,

    init: () => {
        if (iniciado) return;
        iniciado = true;

        void get().refrescar();
        timer = window.setInterval(() => void get().refrescar(), REFRESCO_MS);
    },

    refrescar: async () => {
        try {
            const e = await commands.verifactuEstado();
            set({
                datosFiscalesCompletos: e.datos_fiscales_completos !== false,
                listo: true,
            });
        } catch {
            // Una Handy no tiene registros de facturación y este comando falla ahí. No es un error
            // que haya que enseñar.
            set({ listo: true });
        }
    },

    reconocerDatos: () => set({ datosReconocidos: true }),
}));

/** Para los tests y para un cierre de sesión: deja el store como recién cargado. */
export function _resetEstadoFiscal(): void {
    if (timer !== null) window.clearInterval(timer);
    timer = null;
    iniciado = false;
    useEstadoFiscal.setState({ ...INICIAL });
}
