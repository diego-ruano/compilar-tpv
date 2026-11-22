// test/facturasDeLaFicha.test.ts
//
// Las facturas de un cliente en su ficha: cómo se nombra cada una, su fecha, el nombre de su PDF y
// lo que se reimprime.

import { describe, expect, it } from "vitest";

import {
    etiquetaClase,
    fechaDeLaFactura,
    nombreDelPdf,
    reimpresionDe,
} from "../src/features/clientes/facturasDeLaFicha";

describe("facturas del cliente", () => {
    it("cada clase se llama por lo que es", () => {
        expect(etiquetaClase("factura")).toBe("Factura");
        expect(etiquetaClase("rectificativa")).toBe("Rectificativa");
        expect(etiquetaClase("sustitutiva")).toBe("Sustitutiva");
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
