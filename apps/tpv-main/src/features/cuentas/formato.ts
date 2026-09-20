// src/features/cuentas/formato.ts
//
// Formato de dinero de la pantalla de caja. Vive aparte porque lo usan la pantalla y el cierre, y
// dos copias del mismo formateador acabarian imprimiendo el mismo importe de dos maneras.
//
// Desde ARQ-01 los dos reciben `Dinero` (centimos). `euro` delega en el formateador unico de la
// interfaz: tenerlo aqui otra vez era exactamente la segunda copia que esta cabecera advertia.

import type { Dinero } from "@tpv/contracts";

import { eur } from "../../shared/lib/dinero";

export function euro(d: Dinero) {
    return eur(d);
}

/** Etiqueta corta de una denominacion: "50c" para las monedas pequenas, "20€" para el resto. */
export function moneyLabel(value: Dinero) {
    if (value < 100) return `${value}c`;
    return `${value / 100}€`;
}
