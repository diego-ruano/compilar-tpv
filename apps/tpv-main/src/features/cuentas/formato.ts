// src/features/cuentas/formato.ts
//
// Formato de dinero de la pantalla de caja. Vive aparte porque lo usan la pantalla y el cierre, y
// dos copias del mismo formateador acabarian imprimiendo el mismo importe de dos maneras.

export function euro(n: number) {
    return n.toLocaleString("es-ES", { style: "currency", currency: "EUR" });
}

/** Etiqueta corta de una denominacion: "50c" para las monedas pequenas, "20€" para el resto. */
export function moneyLabel(value: number) {
    if (value < 1) return `${Math.round(value * 100)}c`;
    return `${value}€`;
}
