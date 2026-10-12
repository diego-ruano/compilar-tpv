// src/shared/ui/CampoHora.tsx
//
// **El campo de hora de la interfaz** (`HH:mm`, 24 horas).
//
// Es un campo de texto con teclado numérico y no un `type="time"`, por lo mismo que `CampoDinero`
// no es un `type="number"`: el control nativo es de la webview y del formato de hora del sistema, y
// su valor está vacío hasta que él da por completos todos sus segmentos (también el de AM/PM, si
// el sistema lo pide), aunque en pantalla ya se lean las horas. El formulario decía «falta la hora»
// con la hora a la vista. Aquí lo que se ve es lo que se guarda, igual en WebView2, en Android y en
// WebKit.

import { cn } from "../lib/cn";

/** `HH:mm` de 00:00 a 23:59. */
export function esHora(texto: string): boolean {
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(texto);
}

/**
 * Lo que queda en el campo tras cada pulsación: sólo cifras, y los dos puntos se ponen solos tras
 * la segunda («1230» → «12:30»), así basta el teclado numérico. Quien los escribe antes manda
 * («9:30»).
 */
export function alEscribirHora(texto: string): string {
    const limpio = texto.replace(/[^\d:]/g, "");
    const corte = limpio.indexOf(":");
    if (corte >= 0) {
        const horas = limpio.slice(0, corte).slice(0, 2);
        const minutos = limpio.slice(corte + 1).replace(/:/g, "").slice(0, 2);
        return `${horas}:${minutos}`;
    }
    const cifras = limpio.slice(0, 4);
    return cifras.length > 2 ? `${cifras.slice(0, 2)}:${cifras.slice(2)}` : cifras;
}

/** Al salir del campo: «9:30» → «09:30». Lo que no se entiende se deja como está. */
export function completarHora(texto: string): string {
    const partes = /^(\d):(\d{2})$/.exec(texto);
    return partes ? `0${partes[1]}:${partes[2]}` : texto;
}

export type CampoHoraProps = {
    /** `HH:mm`, o lo que haya escrito a medias. Vacío = sin rellenar. */
    valor: string;
    onCambio: (valor: string) => void;
    id?: string;
    disabled?: boolean;
    className?: string;
    "aria-label"?: string;
};

export function CampoHora({ valor, onCambio, className, ...resto }: CampoHoraProps) {
    return (
        <input
            {...resto}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            placeholder="HH:mm"
            maxLength={5}
            value={valor}
            onChange={(e) => onCambio(alEscribirHora(e.target.value))}
            onBlur={() => {
                const completa = completarHora(valor);
                if (completa !== valor) onCambio(completa);
            }}
            className={cn("border border-border rounded-xl px-3 py-2 outline-none focus:border-accent", className)}
        />
    );
}
