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

/**
 * ¿Ya no vale? La anuló la baja de su cobro, o la sustituyó una rectificativa (la corrección de los
 * datos del cliente). Sigue en la lista (el registro se conserva), pero no se enseña como vigente:
 * con la que la sustituye, parecería el doble de lo facturado.
 */
export function yaNoVale(f: Pick<FacturaDelCliente, "anulada"> & { sustituida_por?: string | null }): boolean {
    return f.anulada || !!f.sustituida_por;
}

/**
 * Lo que se dice de ella debajo del número: su clase y, si ya no vale, por qué: anulada, o
 * sustituida por la rectificativa que la reemplaza.
 */
export function descripcionDeLaFactura(
    f: Pick<FacturaDelCliente, "clase" | "anulada"> & { sustituida_por?: string | null },
): string {
    if (f.anulada) return `${etiquetaClase(f.clase)} anulada`;
    if (f.sustituida_por) return `${etiquetaClase(f.clase)} sustituida por ${f.sustituida_por}`;
    return etiquetaClase(f.clase);
}

/** La fecha de expedición (`DD-MM-AAAA`, como la declara la factura) como se lee: `DD/MM/AAAA`. */
export function fechaDeLaFactura(fecha: string): string {
    return /^\d{2}-\d{2}-\d{4}$/.test(fecha) ? fecha.replace(/-/g, "/") : fecha;
}

/**
 * El nombre con el que se ofrece guardar su PDF: `factura_2026-000012.pdf`. El número lleva `/`, que
 * no puede ir en un nombre de fichero; y nada de lo que Windows no admite. El de una anulada o
 * sustituida lo dice en el nombre (`…_anulada.pdf`, `…_sustituida.pdf`): el PDF es el que se
 * emitió y no lleva la marca.
 */
export function nombreDelPdf(
    f: Pick<FacturaDelCliente, "num_serie"> & { anulada?: boolean; sustituida_por?: string | null },
): string {
    const numero = f.num_serie
        .trim()
        .replace(/[\/:*?"<>|\s]+/g, "-")
        .replace(/^[-.]+|[-.]+$/g, "");
    const marca = f.anulada ? "_anulada" : f.sustituida_por ? "_sustituida" : "";
    return `factura_${numero || "sin-numero"}${marca}.pdf`;
}

/**
 * Lo que abre el modal de impresión para reimprimirla: el papel de su cobro con su número, marcado
 * COPIA. `null` si su cobro no está en este equipo (una sustitutiva de tickets que no han bajado).
 */
export function reimpresionDe(f: Pick<FacturaDelCliente, "id_pago" | "num_serie">): CobroImprimible | null {
    return f.id_pago ? { idPago: f.id_pago, esCopia: true, numFactura: f.num_serie } : null;
}
