// apps/tpv-main/test/claveLicencia.test.ts
//
// LIC-INC-01 · La forma de la clave de licencia en la pantalla, contra la tabla que comparte con la
// Main (`clave_canonica`, `tpv-domain/src/licensing.rs`) y con la nube (`normalizeLicenseKey`).

import { describe, expect, it } from "vitest";

import casosJson from "../../../crates/tpv-domain/src/clave_licencia_casos.json?raw";
import { avisoDeClave, claveCanonica, EJEMPLO_CLAVE, MSG_CLAVE_MAL_FORMADA } from "../src/shared/lib/claveLicencia";

const tabla = JSON.parse(casosJson) as { mensaje: string; casos: [string, string | null, string][] };

describe("claveCanonica (igual que `clave_canonica` de Rust y `normalizeLicenseKey` del worker)", () => {
    it("la tabla compartida no está vacía", () => {
        expect(tabla.casos.length).toBeGreaterThan(10);
    });

    it.each(tabla.casos)("%j → %j: %s", (entrada, canonica) => {
        expect(claveCanonica(entrada)).toBe(canonica);
    });

    it("el aviso es el texto de la tabla, el mismo que dan la Main y la nube", () => {
        expect(MSG_CLAVE_MAL_FORMADA).toBe(tabla.mensaje);
    });

    it("el ejemplo del campo es el formato de verdad, y lo nombra el aviso", () => {
        expect(EJEMPLO_CLAVE).toBe("TPV-XXXXX-XXXXX-XXXXX-XXXXX");
        expect(MSG_CLAVE_MAL_FORMADA).toContain(EJEMPLO_CLAVE);
    });
});

describe("avisoDeClave", () => {
    it("mientras se escribe no avisa; al dejar el campo con algo que no es una clave, sí", () => {
        expect(avisoDeClave("TPV-ABCD", false)).toBeNull();
        expect(avisoDeClave("TPV-ABCD", true)).toBe(MSG_CLAVE_MAL_FORMADA);
    });

    it("un campo vacío o una clave bien escrita no llevan aviso", () => {
        expect(avisoDeClave("   ", true)).toBeNull();
        expect(avisoDeClave("tpv abcde fghjk mnpqr stvwx", true)).toBeNull();
    });
});
