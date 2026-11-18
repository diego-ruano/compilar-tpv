// Cuentas no enseñaba el proveedor de un gasto cuyo proveedor se borró: la etiqueta la trae la
// lectura (`proveedor_borrado`, la misma que en Estadísticas) y la usan la lista, la confirmación y
// el PDF.
import { expect, it } from "vitest";

import { proveedorDelGasto } from "../src/features/cuentas/proveedorDelGasto";

const nombres = new Map([["prov-1", "Bebidas SL"]]);
const nombreDe = (id: string) => nombres.get(id) ?? id;

it("el de la ficha, en los gastos de tipo proveedor", () => {
    expect(proveedorDelGasto({ tipo_gasto: "Proveedor", proveedor_id: "prov-1", proveedor_borrado: null }, nombreDe)).toBe("Bebidas SL");
    expect(proveedorDelGasto({ tipo_gasto: "Compras", proveedor_id: "prov-1", proveedor_borrado: null }, nombreDe)).toBeNull();
});

it("el de uno borrado, con su marca, en cualquier gasto", () => {
    for (const tipo_gasto of ["Proveedor", "Compras"]) {
        expect(proveedorDelGasto({ tipo_gasto, proveedor_id: null, proveedor_borrado: "Pescados Norte (borrado)" }, nombreDe)).toBe(
            "Pescados Norte (borrado)",
        );
    }
});

it("sin proveedor, nada; también si la lectura es de un worker anterior y no trae el campo", () => {
    expect(proveedorDelGasto({ tipo_gasto: "Suministros", proveedor_id: null, proveedor_borrado: null }, nombreDe)).toBeNull();
    expect(proveedorDelGasto({ tipo_gasto: "Proveedor", proveedor_id: null }, nombreDe)).toBeNull();
});
