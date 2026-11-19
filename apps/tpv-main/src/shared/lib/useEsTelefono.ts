// src/shared/lib/useEsTelefono.ts
import { useEffect, useState } from "react";

/** Por debajo de `sm` (Global.css): el ancho de un teléfono en vertical. */
const CONSULTA = "(max-width: 639px)";

function coincide(): boolean {
    // jsdom (los tests) no trae `matchMedia`.
    return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(CONSULTA).matches;
}

/**
 * ¿La pantalla tiene el ancho de un teléfono? Para lo que el CSS no puede decidir solo, como el
 * zoom de un plano. Cambia si la ventana cambia de ancho.
 */
export function useEsTelefono(): boolean {
    const [esTelefono, setEsTelefono] = useState(coincide);

    useEffect(() => {
        if (typeof window.matchMedia !== "function") return;
        const mq = window.matchMedia(CONSULTA);
        const alCambiar = () => setEsTelefono(mq.matches);
        alCambiar();
        mq.addEventListener("change", alCambiar);
        return () => mq.removeEventListener("change", alCambiar);
    }, []);

    return esTelefono;
}
