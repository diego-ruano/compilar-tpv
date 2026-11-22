// test/fichaFiscal.test.ts
//
// FISCAL-02 · La ficha del cliente en el formulario de la factura completa: qué fichas se ofrecen,
// con qué se rellena, qué se guarda y, sobre todo, CUÁNDO: sólo después de que el cobro o la emisión
// hayan entrado, sin esperar al guardado y sin que su fallo toque el resultado del cobro.

import { describe, expect, it, vi } from "vitest";

import {
    buscarFichas,
    datosDeFicha,
    fichaConNif,
    fichaDestino,
    guardarPorDefecto,
    mismosDatos,
    normalizarNif,
    planDeGuardado,
    rellenoConFicha,
    sirveParaFacturar,
    sugerenciasPorNombre,
    trasFacturar,
    type ClienteParaFactura,
} from "../src/features/clientes/fichaFiscal";

const ficha = (id: string, nombre: string, extra: Partial<ClienteParaFactura> = {}): ClienteParaFactura => ({
    id_cliente: id,
    nombre,
    nif: null,
    razon_social: null,
    direccion_fiscal: null,
    ...extra,
});

const ANA = ficha("c1", "Ana García");
const COMIDAS = ficha("c2", "Paco (comidas de empresa)", {
    nif: "B12345674",
    razon_social: "Comidas Peñalver SL",
    direccion_fiscal: "Calle Mayor 1, Madrid",
});
const ROSA = ficha("c3", "Rosa", { nif: "12345678Z" });
const FICHAS = [ANA, COMIDAS, ROSA];

describe("qué fichas se ofrecen", () => {
    it("el buscador mira el nombre, la razón social y el NIF, sin acentos ni mayúsculas", () => {
        expect(buscarFichas(FICHAS, "penalver")).toEqual([COMIDAS]);
        expect(buscarFichas(FICHAS, "GARCIA")).toEqual([ANA]);
        expect(buscarFichas(FICHAS, "b1234")).toEqual([COMIDAS]);
        expect(buscarFichas(FICHAS, "b-1234")).toEqual([COMIDAS]);
        expect(buscarFichas(FICHAS, "   ")).toEqual([]);
    });

    it("primero las que ya tienen NIF", () => {
        const sinNif = ficha("c4", "Comidas sin NIF");
        expect(buscarFichas([sinNif, COMIDAS], "comidas").map((f) => f.id_cliente)).toEqual(["c2", "c4"]);
    });

    it("un NIF completo y válido encuentra su ficha, escrito como sea", () => {
        expect(fichaConNif(FICHAS, " b-12345674 ")).toBe(COMIDAS);
        expect(fichaConNif(FICHAS, "12345678z")).toBe(ROSA);
        expect(fichaConNif(FICHAS, "B1234567")).toBeNull();
        expect(fichaConNif(FICHAS, "A58818501")).toBeNull();
    });

    it("el nombre sugiere fichas a partir de tres letras, también por la razón social", () => {
        expect(sugerenciasPorNombre(FICHAS, "co")).toEqual([]);
        expect(sugerenciasPorNombre(FICHAS, "peñal")).toEqual([COMIDAS]);
        expect(sugerenciasPorNombre(FICHAS, "ros")).toEqual([ROSA]);
        expect(sugerenciasPorNombre(FICHAS, "ros", "c3")).toEqual([]);
    });
});

describe("con qué se rellena y qué se guarda", () => {
    it("la razón social, o el nombre si no la tiene", () => {
        expect(datosDeFicha(COMIDAS)).toEqual({ nombre_razon: "Comidas Peñalver SL", nif: "B12345674", domicilio: "Calle Mayor 1, Madrid" });
        expect(datosDeFicha(ROSA)).toEqual({ nombre_razon: "Rosa", nif: "12345678Z", domicilio: undefined });
        expect(sirveParaFacturar(ANA)).toBe(false);
        expect(sirveParaFacturar(COMIDAS)).toBe(true);
    });

    it("la casilla sale marcada si no hay ficha o si los datos son otros", () => {
        const iguales = { nombre_razon: " Comidas  Peñalver SL ", nif: "b-12345674", domicilio: "Calle Mayor 1, Madrid" };
        expect(mismosDatos(iguales, COMIDAS)).toBe(true);
        expect(guardarPorDefecto(iguales, COMIDAS)).toBe(false);
        expect(guardarPorDefecto({ ...iguales, domicilio: "Otra calle 2" }, COMIDAS)).toBe(true);
        expect(guardarPorDefecto(iguales, null)).toBe(true);
    });

    it("con ficha se guardan los suyos; sin ficha, va sin id (el backend busca el NIF o da de alta)", () => {
        const d = { nombre_razon: " Comidas SL ", nif: "b-12345674 ", domicilio: "  " };
        expect(planDeGuardado(d, COMIDAS)).toEqual({ id_cliente: "c2", nif: "B12345674", razon_social: "Comidas SL", direccion_fiscal: null });
        expect(planDeGuardado(d, null).id_cliente).toBeNull();
        expect(normalizarNif(" x-1234567 l")).toBe("X1234567L");
    });
});

describe("en qué ficha se guarda", () => {
    // Ana reservó con su ficha (NIF 12345678Z) y la factura es a nombre de su empresa.
    const ANA_CON_NIF = ficha("c4", "Ana", { nif: "12345678Z", razon_social: "Ana López" });

    it("en la elegida, si el NIF es el suyo o no tenía", () => {
        expect(fichaDestino(ANA_CON_NIF, ANA_CON_NIF, "12345678-z")).toBe(ANA_CON_NIF);
        // Una ficha sin NIF se elige para ponérselo.
        expect(fichaDestino(ANA, null, "A58818501")).toBe(ANA);
        expect(fichaDestino(null, COMIDAS, "B12345674")).toBe(COMIDAS);
        expect(fichaDestino(null, null, "A58818501")).toBeNull();
    });

    it("no en la elegida si el NIF es otro: el de otra ficha, o una ficha nueva", () => {
        // El NIF de la empresa ya tiene ficha: ésa.
        expect(fichaDestino(ANA_CON_NIF, COMIDAS, "B12345674")).toBe(COMIDAS);
        // No la tiene: una nueva, y la de Ana no pierde su NIF.
        expect(fichaDestino(ANA_CON_NIF, null, "A58818501")).toBeNull();
        expect(planDeGuardado({ nombre_razon: "Otra SA", nif: "A58818501" }, fichaDestino(ANA_CON_NIF, null, "A58818501")).id_cliente).toBeNull();
        // Una ficha sin NIF elegida, con el NIF de otra: tampoco se duplica.
        expect(fichaDestino(ANA, COMIDAS, "B12345674")).toBe(COMIDAS);
    });
});

describe("con qué queda el formulario al elegir una ficha", () => {
    const VACIO = { nombre: "", nif: "", domicilio: "" };

    it("la primera vez, lo que la ficha no tiene se deja como estaba", () => {
        const escrito = { nombre: "x", nif: "A58818501", domicilio: "Calle 2" };
        expect(rellenoConFicha(escrito, ANA, false)).toEqual({ nombre: "Ana García", nif: "A58818501", domicilio: "Calle 2" });
        expect(rellenoConFicha(VACIO, COMIDAS, false)).toEqual({
            nombre: "Comidas Peñalver SL",
            nif: "B12345674",
            domicilio: "Calle Mayor 1, Madrid",
        });
    });

    it("tras otra ficha, se sustituye todo: no se mezclan los datos de las dos", () => {
        const deComidas = rellenoConFicha(VACIO, COMIDAS, false);
        expect(rellenoConFicha(deComidas, ANA, true)).toEqual({ nombre: "Ana García", nif: "", domicilio: "" });
        expect(rellenoConFicha(deComidas, ROSA, true)).toEqual({ nombre: "Rosa", nif: "12345678Z", domicilio: "" });
    });
});

describe("el guardado va después del cobro, y no lo toca", () => {
    const plan = planDeGuardado({ nombre_razon: "Comidas SL", nif: "B12345674" }, null);

    it("si el cobro no entra, no se guarda nada", async () => {
        const guardar = vi.fn();
        expect(await trasFacturar(async () => false, plan, guardar)).toBe(false);
        expect(guardar).not.toHaveBeenCalled();
    });

    it("si el cobro falla, el fallo es el del cobro y no se guarda nada", async () => {
        const guardar = vi.fn();
        await expect(trasFacturar(async () => { throw new Error("sin conexión"); }, plan, guardar)).rejects.toThrow("sin conexión");
        expect(guardar).not.toHaveBeenCalled();
    });

    it("si entra, se guarda DESPUÉS, una vez", async () => {
        const orden: string[] = [];
        const guardar = vi.fn(() => orden.push("guardar"));
        const ok = await trasFacturar(async () => { orden.push("cobrar"); return true; }, plan, guardar);
        expect(ok).toBe(true);
        expect(orden).toEqual(["cobrar", "guardar"]);
        expect(guardar).toHaveBeenCalledWith(plan);
    });

    it("sin casilla no se guarda, y un guardado que revienta no cambia que el cobro entró", async () => {
        const guardar = vi.fn();
        expect(await trasFacturar(async () => true, null, guardar)).toBe(true);
        expect(guardar).not.toHaveBeenCalled();
        const revienta = vi.fn(() => { throw new Error("sin base"); });
        expect(await trasFacturar(async () => true, plan, revienta)).toBe(true);
    });
});
