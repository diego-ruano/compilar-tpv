// apps/tpv-main/test/nif.test.ts
//
// La validación del NIF de la pantalla contra la misma tabla que `nif_valido` de Rust
// (`crates/tpv-domain/src/verifactu.rs`, test `nif_misma_tabla_que_la_pantalla`). Si un lado cambia
// de criterio, falla el test del otro.
//
// Además de la tabla, dos propiedades que son la razón de validar al escribir: un error de UNA cifra
// al dictar el NIF se detecta siempre. Si dejara de detectarse, el NIF mal dictado saldría hacia la
// AEAT y volvería horas después como «NIF no censado», sin el cliente delante.

import { describe, expect, it } from "vitest";

import { nifValido } from "../src/shared/ticket/nif";

/** Espacio duro: el que se cuela al copiar un NIF de una web o de un PDF. */
const NBSP = String.fromCharCode(0xa0);
/** «ſ» (s larga): `toUpperCase()` la convierte en «S», que sí es una letra de control. */
const S_LARGA = String.fromCharCode(0x17f);

describe("nifValido (igual que `nif_valido` de Rust)", () => {
    it.each([
        // Persona física
        "12345678Z",
        "89890001K", // el de los ejemplos oficiales de la AEAT
        "00000015S",
        // Se limpia igual que en Rust: extremos, minúsculas ASCII, guiones y espacios normales
        " 12345678z ",
        "12345678-Z",
        "12 345 678 Z",
        // NIE
        "X1234567L",
        "Y1234567X",
        "Z1234567R",
        "x-1234567-l",
        // CIF: sólo dígito (A, B, E, H), sólo letra (K, P, Q, R, S, N, W) o cualquiera de los dos
        "A58818501",
        "A12345674",
        "B12345674",
        "Q2826000H",
        "K1234567D",
        "G12345674",
        "G1234567D",
    ])("«%s» es válido", (nif) => {
        expect(nifValido(nif)).toBe(true);
    });

    it.each([
        ["12345678A", "letra que no corresponde"],
        ["1234567Z", "le falta una cifra"],
        ["12345678", "sin letra"],
        ["12345678ZZ", "le sobra un carácter"],
        ["", "vacío"],
        ["X1234567A", "NIE con la letra de otro"],
        ["B12345670", "CIF con el dígito de otro"],
        ["A1234567D", "una A sólo admite dígito"],
        ["K12345674", "una K sólo admite letra"],
        ["12345678\tZ", "un tabulador en medio no se quita"],
        [`12345678${NBSP}Z`, "un espacio duro en medio no se quita"],
        [`00000015${S_LARGA}`, "una «ſ» no es una «S»"],
    ])("«%s» no lo es: %s", (nif) => {
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
        // «dígito de otro» de la tabla.
        for (const valido of ["A58818501", "B12345674", "Q2826000H", "K1234567D"]) {
            expect(nifValido(valido), valido).toBe(true);
            for (const mal of conUnaCifraCambiada(valido.slice(0, 8))) {
                expect(nifValido(mal + valido[8]), `${valido} → ${mal}${valido[8]}`).toBe(false);
            }
        }
    });
});
