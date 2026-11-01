// INC-20261030-001: las existencias de la ficha son los lotes más el stock suelto, como en el resto
// de la aplicación (`lotes + COALESCE(Stock_Suelto, 0)`). La ficha sumaba sólo los lotes.
import { describe, expect, it } from "vitest";
import { stockTotal } from "../src/features/inventario/utils/inventarioFormat";

const lote = (n: number | null) => ({ Stock_Disponible: n });

describe("stockTotal · existencias de un producto", () => {
    it("suma los lotes y el suelto", () => {
        // El caso de la prueba: un lote de 1 y 2 sueltos son 3, y con otro lote de 2, 5.
        expect(stockTotal([lote(1)], 2)).toBe(3);
        expect(stockTotal([lote(1), lote(2)], 2)).toBe(5);
    });

    it("sin lotes, el suelto; sin suelto, los lotes", () => {
        expect(stockTotal([], 10)).toBe(10);
        expect(stockTotal([lote(3)], null)).toBe(3);
        expect(stockTotal([lote(null)], undefined)).toBe(0);
    });

    it("un suelto negativo (se vendió sin existencias) resta", () => {
        expect(stockTotal([], -1)).toBe(-1);
    });

    it("con decimales, redondeado a milésimas", () => {
        // Dos lotes de 0,250 kg y 1,500 kg sueltos son 2 kg, no 0,5.
        expect(stockTotal([lote(0.25), lote(0.25)], 1.5)).toBe(2);
        expect(stockTotal([lote(0.1), lote(0.2)], 0)).toBe(0.3);
    });
});
