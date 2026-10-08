import { expect, it } from "vitest";
import { reducirModo } from "../src/features/mesas/editor/useModoEditor";
import type { Table } from "../src/features/mesas/editor/geometria";

it("armar el borrado descarta una colocación pendiente", () => {
    const mesa = { id: "borrador" } as Table;
    const colocar = reducirModo({ tipo: "editar" }, { tipo: "colocar", mesa });
    expect(reducirModo(colocar, { tipo: "alternar_borrado" })).toEqual({ tipo: "borrar" });
});

it("añadir un vértice sustituye al borrado y se puede cancelar", () => {
    const vertice = reducirModo({ tipo: "borrar" }, { tipo: "vertice" });
    expect(vertice).toEqual({ tipo: "vertice" });
    expect(reducirModo(vertice, { tipo: "cancelar" })).toEqual({ tipo: "editar" });
});
