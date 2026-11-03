import { describe, expect, it } from "vitest";

import { cambioDeTecla } from "../src/shared/stores/useZoomVentana";

const tecla = (key: string, mods: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = { ctrlKey: true }) => ({
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...mods,
});

describe("los atajos del tamaño de la pantalla", () => {
    it("Ctrl + y Ctrl − acercan y alejan, como en un navegador", () => {
        expect(cambioDeTecla(tecla("+"))).toBe("acercar");
        // Sin Mayús, el + del teclado principal llega como `=`.
        expect(cambioDeTecla(tecla("="))).toBe("acercar");
        expect(cambioDeTecla(tecla("-"))).toBe("alejar");
    });

    it("Ctrl 0 vuelve al automático", () => {
        expect(cambioDeTecla(tecla("0"))).toBe("automatico");
    });

    it("sin Ctrl, o con Alt, es escribir y no se toca", () => {
        expect(cambioDeTecla(tecla("+", {}))).toBeNull();
        expect(cambioDeTecla(tecla("-", { ctrlKey: true, altKey: true }))).toBeNull();
    });

    it("cualquier otra combinación con Ctrl no es del zoom", () => {
        expect(cambioDeTecla(tecla("c"))).toBeNull();
        expect(cambioDeTecla(tecla("1"))).toBeNull();
    });
});
