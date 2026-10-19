// La lógica del widget que no necesita React: las horas que se ofrecen, el calendario y la ruta.

import { describe, expect, it } from "vitest";

import { diaCorto, diaLargo, horaEnTramos, horaInicial, leerRuta, semanasDelMes, textoDeTramos } from "../src/logica";

describe("la hora de llegada, al minuto", () => {
	const tramos = [
		{ desde: "19:40", hasta: "21:50" },
		{ desde: "11:40", hasta: "14:20" },
	];

	it("vale cualquier minuto de un tramo, los dos extremos incluidos", () => {
		for (const h of ["11:40", "11:41", "14:20", "19:40", "20:07", "21:50"]) expect(horaEnTramos(tramos, h), h).toBe(true);
		for (const h of ["11:39", "14:21", "17:00", "21:51", "", "25:00", "9:00"]) expect(horaEnTramos(tramos, h), h).toBe(false);
	});

	it("se empieza por la que ya había si vale ese día, o por la primera del día", () => {
		expect(horaInicial(tramos, "20:07")).toBe("20:07");
		expect(horaInicial(tramos, "17:00")).toBe("11:40");
		expect(horaInicial([], "20:00")).toBe("");
	});

	it("los tramos se dicen en orden", () => {
		expect(textoDeTramos(tramos)).toBe("de 11:40 a 14:20 y de 19:40 a 21:50");
	});
});

describe("el calendario", () => {
	it("empieza en lunes y rellena los huecos", () => {
		// Noviembre de 2026 empieza en domingo: seis huecos delante.
		const semanas = semanasDelMes({ anio: 2026, mes: 10 });
		expect(semanas[0]).toEqual([null, null, null, null, null, null, "2026-11-01"]);
		expect(semanas[semanas.length - 1]).toEqual(["2026-11-30", null, null, null, null, null, null]);
		expect(semanas.flat().filter(Boolean)).toHaveLength(30);
	});

	it("los días, en español", () => {
		expect(diaCorto("2026-10-23")).toBe("vie 23 oct");
		expect(diaLargo("2026-10-23")).toBe("viernes, 23 de octubre");
	});
});

describe("la ruta del widget", () => {
	it("la clave, la pantalla y el token del enlace (que va en el fragmento)", () => {
		expect(leerRuta("/reservas-web/v1/w/rw_abc", "")).toEqual({ clave: "rw_abc", vista: "reservar", token: null });
		expect(leerRuta("/reservas-web/v1/w/rw_abc/cancelar", "#t=TOKEN")).toEqual({ clave: "rw_abc", vista: "cancelar", token: "TOKEN" });
		expect(leerRuta("/otra/cosa", "")).toBeNull();
	});
});
