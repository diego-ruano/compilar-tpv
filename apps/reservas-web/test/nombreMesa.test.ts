// En la Main el nombre de la mesa es libre y el que propone ya es «Mesa 5»: el widget no le pone
// otro «Mesa» delante. Sólo a un número a secas.

import { nombreDeMesa } from "@tpv/plano/nombre";
import { describe, expect, it } from "vitest";

describe("el nombre de una mesa en un texto", () => {
	it("a un número a secas le antepone «Mesa»", () => {
		expect(nombreDeMesa("5")).toBe("Mesa 5");
		expect(nombreDeMesa("12")).toBe("Mesa 12");
	});

	it("un nombre se queda como está, también el «Mesa 1» que propone la Main", () => {
		expect(nombreDeMesa("Mesa 1")).toBe("Mesa 1");
		expect(nombreDeMesa("Terraza 3")).toBe("Terraza 3");
		expect(nombreDeMesa("5B")).toBe("5B");
	});
});
