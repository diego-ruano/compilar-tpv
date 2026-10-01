// src/shared/ticket/nif.ts
//
// La validación del NIF/NIE/CIF del destinatario de una factura completa (FISCAL-02).
//
// ⚠️ Gemela de `nif_valido` en `crates/tpv-domain/src/verifactu.rs`, y lo es a propósito. El backend
// la vuelve a comprobar —quien puede invocar un comando puede mandar lo que quiera—, pero si sólo
// estuviera allí el camarero se enteraría del error después de pulsar cobrar. Las dos leen en sus
// tests la misma tabla, `crates/tpv-domain/src/nif_casos.json`: si una cambia de criterio, falla la
// otra (RI-14).
//
// El sentido en que más duele que se separen es uno: si la pantalla rechaza un NIF que el backend
// aceptaría, el cliente se queda sin factura —y por encima del límite de la simplificada, sin poder
// cobrar— sin que la petición llegue nunca a ningún sitio que lo registre.

/** Letras de control de un NIF de persona física, por el resto entre 23. */
const LETRAS_NIF = "TRWAGMYFPDXBNJZSQVHLCKE";

/** Iniciales de un NIF de persona jurídica o entidad: arts. 3, 4 y 5.2 de la Orden EHA/451/2008. */
const INICIALES_CIF = "ABCDEFGHJNPQRSUVW";

/**
 * Valida un NIF/NIE/CIF español comprobando su dígito o letra de control.
 *
 * Se limpia como en Rust, paso a paso: se recortan los extremos, se pasan a mayúsculas SÓLO las
 * letras ASCII y se quitan guiones y espacios normales. Antes se quitaba cualquier blanco y se usaba
 * `toUpperCase()`, y las dos cosas daban por bueno en pantalla un NIF que el backend rechaza: un
 * espacio duro pegado en medio, o una «ſ» que `toUpperCase()` convierte en «S».
 */
export function nifValido(valor: string): boolean {
    const s = (valor ?? "")
        .trim()
        .replace(/[a-z]/g, (c) => c.toUpperCase())
        .replace(/[- ]/g, "");
    if (s.length !== 9) return false;

    // Persona física: 8 dígitos + letra.
    if (/^\d{8}[A-Z]$/.test(s)) {
        return s[8] === LETRAS_NIF[Number(s.slice(0, 8)) % 23];
    }
    // NIE: X/Y/Z + 7 dígitos + letra (la inicial vale 0/1/2).
    if (/^[XYZ]\d{7}[A-Z]$/.test(s)) {
        const pref = { X: "0", Y: "1", Z: "2" }[s[0] as "X" | "Y" | "Z"];
        return s[8] === LETRAS_NIF[Number(pref + s.slice(1, 8)) % 23];
    }
    // NIF K, L y M: sólo la forma. El art. 20 del RD 1065/2007 dice «siete caracteres alfanuméricos»
    // y no publica cómo se calcula el carácter de control (RI-14).
    if (/^[KLM]/.test(s)) {
        return /^[KLM][0-9A-Z]{7}[A-Z]$/.test(s);
    }
    // CIF: letra + 7 dígitos + control (dígito o letra según la inicial).
    if (INICIALES_CIF.includes(s[0]) && /^[A-Z]\d{7}[0-9A-Z]$/.test(s)) {
        let par = 0;
        let impar = 0;
        for (let i = 0; i < 7; i++) {
            const d = Number(s[1 + i]);
            if (i % 2 === 0) {
                const doble = d * 2;
                impar += Math.floor(doble / 10) + (doble % 10);
            } else {
                par += d;
            }
        }
        const control = (10 - ((par + impar) % 10)) % 10;
        const letra = "JABCDEFGHI"[control];
        const inicial = s[0];
        if ("PQRSNW".includes(inicial)) return s[8] === letra;
        if ("ABEH".includes(inicial)) return s[8] === String(control);
        return s[8] === String(control) || s[8] === letra;
    }
    return false;
}
