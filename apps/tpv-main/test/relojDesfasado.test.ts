// apps/tpv-main/test/relojDesfasado.test.ts
//
// RELOJ-01: la franja del reloj desfasado. Se prueba lo que se pierde en silencio al retocarla: que
// sin medida no se avisa (el 0 de arranque no es «la hora está bien», pero tampoco «está mal»), el
// umbral, el sentido —el desfase es lo que hay que SUMARLE a la hora del equipo, así que positivo es
// atrasada— y que la duración se lee en español natural.

import { describe, expect, it } from "vitest";

import {
	avisoDelReloj,
	duracionEnPalabras,
	textoAvisoReloj,
	UMBRAL_AVISO_RELOJ_MS,
} from "../src/app/arranque/relojDesfasado";

const MIN = 60_000;
const HORA = 60 * MIN;
const DIA = 24 * HORA;

describe("avisoDelReloj", () => {
	it("sin medida no avisa", () => {
		expect(avisoDelReloj(null)).toBeNull();
		expect(avisoDelReloj(undefined)).toBeNull();
		expect(avisoDelReloj(Number.NaN)).toBeNull();
	});

	it("por debajo de cinco minutos, en un sentido o en otro, no avisa", () => {
		expect(UMBRAL_AVISO_RELOJ_MS).toBe(5 * MIN);
		for (const ms of [0, 1_500, -1_500, 2 * MIN, -4 * MIN, 5 * MIN - 1, -(5 * MIN - 1)]) {
			expect(avisoDelReloj(ms)).toBeNull();
		}
	});

	it("desde cinco minutos justos, avisa", () => {
		expect(avisoDelReloj(5 * MIN)).not.toBeNull();
		expect(avisoDelReloj(-5 * MIN)).not.toBeNull();
	});

	it("positivo es que la hora del equipo va atrasada; negativo, adelantada", () => {
		expect(avisoDelReloj(7 * MIN)).toEqual({ sentido: "atrasada", cuanto: "7 minutos" });
		expect(avisoDelReloj(-7 * MIN)).toEqual({ sentido: "adelantada", cuanto: "7 minutos" });
	});
});

describe("duracionEnPalabras", () => {
	it("minutos por debajo de una hora, redondeados", () => {
		expect(duracionEnPalabras(MIN)).toBe("1 minuto");
		expect(duracionEnPalabras(5 * MIN)).toBe("5 minutos");
		expect(duracionEnPalabras(12 * MIN + 29_000)).toBe("12 minutos");
		expect(duracionEnPalabras(12 * MIN + 31_000)).toBe("13 minutos");
		expect(duracionEnPalabras(-(45 * MIN))).toBe("45 minutos");
	});

	it("horas y minutos por debajo de un día", () => {
		expect(duracionEnPalabras(59 * MIN + 40_000)).toBe("1 hora");
		expect(duracionEnPalabras(HORA)).toBe("1 hora");
		expect(duracionEnPalabras(HORA + MIN)).toBe("1 hora y 1 minuto");
		expect(duracionEnPalabras(2 * HORA + 10 * MIN)).toBe("2 horas y 10 minutos");
		expect(duracionEnPalabras(23 * HORA)).toBe("23 horas");
	});

	it("días y horas a partir de un día", () => {
		expect(duracionEnPalabras(DIA)).toBe("1 día");
		expect(duracionEnPalabras(DIA + 3 * HORA + 10 * MIN)).toBe("1 día y 3 horas");
		expect(duracionEnPalabras(3 * DIA)).toBe("3 días");
		// Casi otro día entero: se redondea al día siguiente, no a «2 días y 24 horas».
		expect(duracionEnPalabras(2 * DIA + 23 * HORA + 45 * MIN)).toBe("3 días");
		expect(duracionEnPalabras(-(366 * DIA))).toBe("366 días");
	});
});

describe("textoAvisoReloj", () => {
	it("dice cuánto y hacia dónde, que los tickets y la caja salen con esa hora, y cómo ajustarla en Windows", () => {
		const texto = textoAvisoReloj(avisoDelReloj(-(2 * HORA + 10 * MIN))!, false);
		expect(texto).toContain("La hora de este equipo va 2 horas y 10 minutos adelantada.");
		expect(texto).toContain("Los tickets y la caja salen con la hora del equipo.");
		expect(texto).toContain("Configuración → Hora e idioma → Fecha y hora → «Sincronizar ahora»");
	});

	it("en el teléfono de la Handy, los ajustes del dispositivo", () => {
		const texto = textoAvisoReloj(avisoDelReloj(3 * DIA)!, true);
		expect(texto).toContain("La hora de este equipo va 3 días atrasada.");
		expect(texto).toContain("ajustes del dispositivo");
		expect(texto).toContain("automáticas");
		expect(texto).not.toContain("Windows");
	});
});
