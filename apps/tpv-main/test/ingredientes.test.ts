// Lo que se pide distinto en una línea, como llega de la base (`Cambios_Ingredientes`), y cómo se
// enseña en la comanda, la cocina y el ticket.
import { describe, expect, it } from "vitest";

import {
    agruparPorCategoria,
    cambiosParaGuardar,
    leerCambios,
    textoCambios,
} from "../src/features/inventario/ingredientes";

const guardado = JSON.stringify([
    { id: "i2", nombre: "Queso", tipo: "EXTRA" },
    { id: "i1", nombre: "Cebolla", tipo: "SIN" },
]);

describe("los cambios de ingredientes de una línea", () => {
    it("se leen tal como los guarda la base", () => {
        expect(leerCambios(guardado)).toEqual([
            { id: "i2", nombre: "Queso", tipo: "EXTRA" },
            { id: "i1", nombre: "Cebolla", tipo: "SIN" },
        ]);
    });

    it("sin cambios, o con algo que no se entiende, la línea va como el producto", () => {
        expect(leerCambios(null)).toEqual([]);
        expect(leerCambios("no es json")).toEqual([]);
        expect(leerCambios('{"id":"i1"}')).toEqual([]);
        expect(leerCambios('[{"id":"i1","nombre":"Queso","tipo":"MUCHO"},{"id":"i2","nombre":"Sal","tipo":"SIN"}]')).toEqual([
            { id: "i2", nombre: "Sal", tipo: "SIN" },
        ]);
        expect(textoCambios(null)).toBe("");
    });

    it("se enseñan en una línea", () => {
        expect(textoCambios(guardado)).toBe("EXTRA Queso · SIN Cebolla");
    });

    it("se mandan primero los «sin» y luego los «extra»", () => {
        expect(cambiosParaGuardar(leerCambios(guardado))).toEqual([
            { id_ingrediente: "i1", nombre: "Cebolla", tipo: "SIN" },
            { id_ingrediente: "i2", nombre: "Queso", tipo: "EXTRA" },
        ]);
    });
});

it("el catálogo se agrupa por categoría y por nombre, con acentos", () => {
    const grupos = agruparPorCategoria({
        categorias: [
            { ID_Categoria_Ingrediente: "c2", Nombre: "Salsas" },
            { ID_Categoria_Ingrediente: "c1", Nombre: "Pan" },
        ],
        ingredientes: [
            { ID_Ingrediente: "a", ID_Categoria_Ingrediente: "c1", Nombre: "Integral" },
            { ID_Ingrediente: "b", ID_Categoria_Ingrediente: "c1", Nombre: "Ángel" },
            { ID_Ingrediente: "c", ID_Categoria_Ingrediente: "c2", Nombre: "alioli" },
        ],
    });
    expect(grupos.map((g) => [g.categoria.Nombre, g.ingredientes.map((i) => i.Nombre)])).toEqual([
        ["Pan", ["Ángel", "Integral"]],
        ["Salsas", ["alioli"]],
    ]);
});
