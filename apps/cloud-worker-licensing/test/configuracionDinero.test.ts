// test/configuracionDinero.test.ts
//
// RI-66: el umbral de descuadre es dinero, en céntimos ENTEROS. El builder lo convertía con
// `Number(...)`, así que un decimal entraba como REAL en una columna de dinero y un `null` se
// guardaba como 0. Ahora un decimal se rechaza en la puerta (como `zDinero` en el resto del worker)
// y `null`/ausente no toca la columna, igual que en la Main (`configuracion.rs::patch_dinero`).
//
// Que un importe entero quede como entero en los dos lados lo fija además el caso de contrato
// `configuracion/patch_business`; esto cubre lo que el harness no puede: los rechazos.

import { describe, it, expect } from "vitest";

import { patchBusiness } from "../src/domains/configuracion/configuracion.commands";
import { HubError } from "../src/lib/errorHttp";

/** Los argumentos del UPDATE que construye el builder (el paso 0 es el INSERT OR IGNORE). */
function update(patch: Record<string, unknown>): { sql: string; args: unknown[] } | undefined {
	const steps = (patchBusiness(patch).command as any).payload.steps as any[];
	return steps.find((s) => String(s.sql).startsWith("UPDATE Business_Settings"));
}

describe("patchBusiness: el umbral de descuadre (RI-66)", () => {
	it("un entero de céntimos se escribe tal cual", () => {
		const u = update({ umbral_descuadre: 750 });
		expect(u?.sql).toContain("Umbral_Descuadre = ?1");
		expect(u?.args[0]).toBe(750);
	});

	it.each([[7.5], ["7,50"], ["750"], [Number.NaN]])("%s se rechaza y no se redondea", (valor) => {
		let error: unknown;
		try {
			patchBusiness({ umbral_descuadre: valor });
		} catch (e) {
			error = e;
		}
		expect(error).toBeInstanceOf(HubError);
		expect((error as HubError).code).toBe("validation_error");
		expect((error as HubError).status).toBe(400);
	});

	it("null o ausente no toca la columna (antes un null la ponía a 0)", () => {
		expect(update({ umbral_descuadre: null })).toBeUndefined();
		const u = update({ umbral_descuadre: null, business_name: "Bar" });
		expect(u?.sql).not.toContain("Umbral_Descuadre");
	});
});
