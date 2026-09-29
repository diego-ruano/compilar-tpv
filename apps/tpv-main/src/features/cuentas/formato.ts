// src/features/cuentas/formato.ts
//
// La etiqueta de una moneda o un billete del contador de caja. Los importes NO se formatean aquí:
// eso es `eur` (`shared/lib/dinero.ts`), el único formateador de la interfaz.

import type { Dinero } from "@tpv/contracts";

/** Etiqueta corta de una denominacion: "50c" para las monedas pequenas, "20€" para el resto. */
export function moneyLabel(value: Dinero) {
    if (value < 100) return `${value}c`;
    return `${value / 100}€`;
}
