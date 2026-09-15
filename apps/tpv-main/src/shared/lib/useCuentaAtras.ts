// src/shared/lib/useCuentaAtras.ts
//
// Segundos que faltan hasta un instante, refrescados cada segundo mientras cuentan. Lo usan los
// botones de «Enviar otro código» (LOGIN-07 / LOGIN-08): la espera la hace cumplir el worker, esto
// sólo evita que alguien pulse para nada y le diga cuánto le queda.

import { useEffect, useState } from "react";

function restantes(hastaMs: number | null): number {
    if (!hastaMs) return 0;
    return Math.max(0, Math.ceil((hastaMs - Date.now()) / 1000));
}

export function useCuentaAtras(hastaMs: number | null): number {
    const [segundos, setSegundos] = useState(() => restantes(hastaMs));

    useEffect(() => {
        setSegundos(restantes(hastaMs));
        if (!hastaMs) return;
        const id = window.setInterval(() => {
            const s = restantes(hastaMs);
            setSegundos(s);
            if (s <= 0) window.clearInterval(id);
        }, 1000);
        return () => window.clearInterval(id);
    }, [hastaMs]);

    return segundos;
}

/** `4:05`. */
export function formatoCuentaAtras(segundos: number): string {
    const m = Math.floor(segundos / 60);
    const s = segundos % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
}
