// src/shared/stores/useZoomVentana.ts
//
// El tamaño de la interfaz en el escritorio. Lo decide y lo aplica Rust (`zoom.rs`): automático
// según el monitor, o fijado a mano en este equipo. Aquí sólo está lo que enseña la barra de arriba
// y los atajos de teclado, para que los botones y el teclado vean el mismo porcentaje.

import { create } from "zustand";
import { commands } from "@tpv/client";
import type { CambioZoom, ZoomVentana } from "@tpv/contracts";

import { avisarDelFallo } from "../lib/conAviso";
import { esMovil } from "../lib/plataforma";

type Estado = {
    zoom: ZoomVentana | null;
    refrescar: () => Promise<void>;
    cambiar: (cambio: CambioZoom) => Promise<void>;
};

export const useZoomVentana = create<Estado>((set) => ({
    zoom: null,
    refrescar: async () => {
        set({ zoom: await commands.ventanaZoomEstado() });
    },
    cambiar: async (cambio) => {
        set({ zoom: await commands.ventanaZoomCambiar({ cambio }) });
    },
}));

/** Ctrl + / Ctrl − / Ctrl 0, como en un navegador. `null` si la tecla no es de zoom. */
export function cambioDeTecla(e: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "key">): CambioZoom | null {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
    switch (e.key) {
        case "+":
        case "=":
            return "acercar";
        case "-":
            return "alejar";
        case "0":
            return "automatico";
        default:
            return null;
    }
}

let iniciado = false;

/** Lee el zoom actual y engancha los atajos y el refresco. Va una vez, al arrancar. */
export function iniciarZoomVentana(): void {
    if (esMovil || iniciado) return;
    iniciado = true;
    const { refrescar, cambiar } = useZoomVentana.getState();

    refrescar().catch((e: unknown) => avisarDelFallo("No se pudo leer el tamaño de la pantalla", e));

    window.addEventListener("keydown", (e) => {
        const cambio = cambioDeTecla(e);
        if (!cambio) return;
        e.preventDefault();
        cambiar(cambio).catch((err: unknown) => avisarDelFallo("No se pudo cambiar el tamaño", err));
    });

    // En automático el zoom cambia si la ventana pasa a otro monitor; cambiar el zoom también
    // dispara `resize`. Se relee al terminar, no en cada evento del arrastre.
    let espera: number | undefined;
    window.addEventListener("resize", () => {
        window.clearTimeout(espera);
        espera = window.setTimeout(() => {
            refrescar().catch(() => {
                // Ya lo registró `invocar`; el porcentaje de la barra se queda en el anterior.
            });
        }, 300);
    });
}
