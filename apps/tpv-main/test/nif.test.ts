// apps/tpv-main/test/nif.test.ts
//
// La validación del NIF de la pantalla contra la tabla que comparte con `nif_valido` de Rust
// (`crates/tpv-domain/src/nif_casos.json`, test `nif_misma_tabla_que_la_pantalla`). Si un lado
// cambia de criterio, falla el test del otro (RI-14).
//
// Además de la tabla, dos propiedades que son la razón de validar al escribir: un error de UNA cifra
// al dictar el NIF se detecta siempre. Si dejara de detectarse, el NIF mal dictado saldría hacia la
// AEAT y volvería horas después como «NIF no censado», sin el cliente delante.

import { describe, expect, it } from "vitest";

import casosJson from "../../../crates/tpv-domain/src/nif_casos.json?raw";
import { nifValido } from "../src/shared/ticket/nif";

const casos = JSON.parse(casosJson) as {
    validos: [string, string][];
    invalidos: [string, string][];
};

describe("nifValido (igual que `nif_valido` de Rust)", () => {
    it("la tabla compartida no está vacía", () => {
        expect(casos.validos.length).toBeGreaterThan(0);
        expect(casos.invalidos.length).toBeGreaterThan(0);
    });

    it.each(casos.validos)("«%s» es válido: %s", (nif) => {
        expect(nifValido(nif)).toBe(true);
    });

    it.each(casos.invalidos)("«%s» no lo es: %s", (nif) => {
        expect(nifValido(nif)).toBe(false);
    });
});

describe("un error de una cifra al dictar se detecta siempre", () => {
    /** Todas las formas de cambiar UNA cifra de `nif` por otra. */
    function conUnaCifraCambiada(nif: string): string[] {
        const variantes: string[] = [];
        for (let i = 0; i < nif.length; i++) {
            if (!/\d/.test(nif[i])) continue;
            for (let d = 0; d <= 9; d++) {
                if (String(d) !== nif[i]) variantes.push(nif.slice(0, i) + d + nif.slice(i + 1));
            }
        }
        return variantes;
    }

    it("en un NIF y en un NIE", () => {
        for (const valido of ["12345678Z", "89890001K", "00000015S", "X1234567L", "Z1234567R"]) {
            expect(nifValido(valido), valido).toBe(true);
            for (const mal of conUnaCifraCambiada(valido)) {
                expect(nifValido(mal), `${valido} → ${mal}`).toBe(false);
            }
        }
    });

    it("en un CIF, tanto si el control es dígito como si es letra", () => {
        // Sólo se cambian las cifras del cuerpo: cambiar el dígito de control por otro es ya el caso
        // «dígito de otro» de la tabla. Los NIF K, L y M no entran: sólo se valida su forma, porque
        // su carácter de control no tiene algoritmo publicado.
        for (const valido of ["A58818501", "B12345674", "Q2826000H", "G1234567D"]) {
            expect(nifValido(valido), valido).toBe(true);
            for (const mal of conUnaCifraCambiada(valido.slice(0, 8))) {
                expect(nifValido(mal + valido[8]), `${valido} → ${mal}${valido[8]}`).toBe(false);
            }
        }
    });
});
