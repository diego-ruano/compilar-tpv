// test/facturasDeLaFicha.test.ts
//
// Las facturas de un cliente en su ficha: cómo se nombra cada una, su fecha, el nombre de su PDF y
// lo que se reimprime.

import { describe, expect, it } from "vitest";

import {
    descripcionDeLaFactura,
    etiquetaClase,
    fechaDeLaFactura,
    nombreDelPdf,
    reimpresionDe,
    yaNoVale,
} from "../src/features/clientes/facturasDeLaFicha";

describe("facturas del cliente", () => {
    it("cada clase se llama por lo que es", () => {
        expect(etiquetaClase("factura")).toBe("Factura");
        expect(etiquetaClase("rectificativa")).toBe("Rectificativa");
        expect(etiquetaClase("sustitutiva")).toBe("Sustitutiva");
    });

    it("una factura anulada se dice anulada, y su PDF también", () => {
        expect(descripcionDeLaFactura({ clase: "factura", anulada: false })).toBe("Factura");
        expect(descripcionDeLaFactura({ clase: "factura", anulada: true })).toBe("Factura anulada");
        expect(descripcionDeLaFactura({ clase: "sustitutiva", anulada: true })).toBe("Sustitutiva anulada");
        expect(nombreDelPdf({ num_serie: "F-000001", anulada: true })).toBe("factura_F-000001_anulada.pdf");
    });

    it("una factura sustituida por la corrección de su cliente se dice sustituida y ya no vale", () => {
        const sustituida = { clase: "factura" as const, anulada: false, sustituida_por: "R-000001" };
        expect(descripcionDeLaFactura(sustituida)).toBe("Factura sustituida por R-000001");
        expect(yaNoVale(sustituida)).toBe(true);
        expect(yaNoVale({ anulada: true, sustituida_por: null })).toBe(true);
        expect(yaNoVale({ anulada: false, sustituida_por: null })).toBe(false);
        expect(nombreDelPdf({ num_serie: "F-000001", sustituida_por: "R-000001" })).toBe(
            "factura_F-000001_sustituida.pdf",
        );
    });

    it("al corregir el cliente de una F3, la errónea se dice sustituida y la negativa dice cuál contrarresta", () => {
        const erronea = { clase: "sustitutiva" as const, anulada: false, sustituida_por: "F-000004", contrarresta: null };
        expect(descripcionDeLaFactura(erronea)).toBe("Sustitutiva sustituida por F-000004");
        expect(yaNoVale(erronea)).toBe(true);
        const negativa = { clase: "sustitutiva" as const, anulada: false, sustituida_por: null, contrarresta: "F-000002" };
        expect(descripcionDeLaFactura(negativa)).toBe("Sustitutiva que contrarresta la F-000002");
        // Es una factura emitida: vale, aunque deje sin efecto otra.
        expect(yaNoVale(negativa)).toBe(false);
    });

    it("la fecha declarada se lee con barras, y lo que no tiene su forma sale tal cual", () => {
        expect(fechaDeLaFactura("02-01-2026")).toBe("02/01/2026");
        expect(fechaDeLaFactura("2026-01-02")).toBe("2026-01-02");
        expect(fechaDeLaFactura("")).toBe("");
    });

    it("el PDF se ofrece con el número, sin lo que no cabe en un nombre de fichero", () => {
        expect(nombreDelPdf({ num_serie: "2026/000012" })).toBe("factura_2026-000012.pdf");
        expect(nombreDelPdf({ num_serie: "F-000001" })).toBe("factura_F-000001.pdf");
        expect(nombreDelPdf({ num_serie: " R2026:1 *x? " })).toBe("factura_R2026-1-x.pdf");
        expect(nombreDelPdf({ num_serie: "../.." })).toBe("factura_sin-numero.pdf");
        expect(nombreDelPdf({ num_serie: "" })).toBe("factura_sin-numero.pdf");
    });

    it("se reimprime como copia del papel de su cobro con su número", () => {
        expect(reimpresionDe({ id_pago: "p1", num_serie: "2026/000012" })).toEqual({
            idPago: "p1",
            esCopia: true,
            numFactura: "2026/000012",
        });
        expect(reimpresionDe({ id_pago: null, num_serie: "2026/000013" })).toBeNull();
    });
});
