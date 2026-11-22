// test/nifComoLaMain.test.ts
//
// FISCAL-02 · El NIF de la ficha de un cliente se valida en el worker como en la Main: contra la
// misma tabla que leen `nif_valido` (crates/tpv-domain/src/verifactu.rs) y la pantalla
// (apps/tpv-main/src/shared/ticket/nif.ts). Si un lado cambia de criterio, se pone rojo el otro
// (RI-14). Cómo queda cada campo de la ficha lo fijan los casos `cliente` de validacion_casos.json.

import { describe, expect, it } from "vitest";

import casosJson from "../../../crates/tpv-domain/src/nif_casos.json?raw";
import { nifValido, normalizarNif, sanearTexto } from "../src/lib/fiscal";

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

describe("normalizarNif y sanearTexto (como `normalizar_nif` y `sanear_texto`)", () => {
	it("el NIF se recorta como str::trim y sólo pasa a mayúsculas las letras ASCII", () => {
		expect(normalizarNif(" b-1234567 4\u0085")).toBe("B12345674");
		// U+FEFF no es un espacio para Rust: se queda, y el NIF no vale.
		expect(normalizarNif("﻿12345678z")).toBe("﻿12345678Z");
		expect(nifValido("﻿12345678z")).toBe(false);
		expect(normalizarNif("ſ1234567A")).toBe("ſ1234567A");
	});

	it("corta por caracteres, no por unidades UTF-16, y no deja un blanco al final", () => {
		expect(sanearTexto("𝄞".repeat(5), 3)).toBe("𝄞𝄞𝄞");
		expect(sanearTexto("ab cd", 3)).toBe("ab");
		expect(sanearTexto("  a  <b>  ", 10)).toBe("a b");
		expect(sanearTexto("a\u007fb", 10)).toBe("a\u007fb");
	});
});
