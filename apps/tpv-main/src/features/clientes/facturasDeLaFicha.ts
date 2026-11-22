// src/features/clientes/facturasDeLaFicha.ts
//
// Las facturas completas de un cliente en su ficha (sólo en la Main): cómo se llama cada una, cómo
// se enseña su fecha y con qué nombre se guarda su PDF. Lógica sin pantalla: la usa
// `FacturasDelCliente.tsx` y la prueba `test/facturasDeLaFicha.test.ts`.

import type { ClaseFactura, FacturaDelCliente } from "@tpv/contracts";

import type { CobroImprimible } from "../../shared/ticket/PrintTicketModal";

export type { FacturaDelCliente };

/** Cómo se llama cada clase de factura en la lista. */
export function etiquetaClase(clase: ClaseFactura): string {
    switch (clase) {
        case "rectificativa":
            return "Rectificativa";
        case "sustitutiva":
            return "Sustitutiva";
        default:
            return "Factura";
    }
}

/** La fecha de expedición (`DD-MM-AAAA`, como la declara la factura) como se lee: `DD/MM/AAAA`. */
export function fechaDeLaFactura(fecha: string): string {
    return /^\d{2}-\d{2}-\d{4}$/.test(fecha) ? fecha.replace(/-/g, "/") : fecha;
}

/**
 * El nombre con el que se ofrece guardar su PDF: `factura_2026-000012.pdf`. El número lleva `/`, que
 * no puede ir en un nombre de fichero; y nada de lo que Windows no admite.
 */
export function nombreDelPdf(f: Pick<FacturaDelCliente, "num_serie">): string {
    const numero = f.num_serie
        .trim()
        .replace(/[\/:*?"<>|\s]+/g, "-")
        .replace(/^[-.]+|[-.]+$/g, "");
    return `factura_${numero || "sin-numero"}.pdf`;
}

/**
 * Lo que abre el modal de impresión para reimprimirla: el papel de su cobro con su número, marcado
 * COPIA. `null` si su cobro no está en este equipo (una sustitutiva de tickets que no han bajado).
 */
export function reimpresionDe(f: Pick<FacturaDelCliente, "id_pago" | "num_serie">): CobroImprimible | null {
    return f.id_pago ? { idPago: f.id_pago, esCopia: true, numFactura: f.num_serie } : null;
}
