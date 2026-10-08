import type { PDFFont } from "pdf-lib";

/** RI-82: Helvetica admite ñ, tildes, €, ¿, ¡, º y ª; sólo se sustituye lo no codificable. */
export function textoPdf(texto: string, fuente: PDFFont): string {
    return Array.from(texto.normalize("NFC"), (caracter) => {
        try {
            fuente.encodeText(caracter);
            return caracter;
        } catch {
            return "?";
        }
    }).join("");
}
