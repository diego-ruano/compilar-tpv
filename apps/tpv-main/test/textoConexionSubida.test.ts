// test/textoConexionSubida.test.ts
//
// DO-SUBIDA · Lo que dice Configuración → Conectividad mientras este TPV devuelve sus datos a una
// nube que soporte ha restaurado (una copia, una base vacía, una vuelta a un instante).
//
// Con los Handy retenidos se dice por qué esperan, y que este TPV sigue cobrando. Con los Handy ya
// sueltos (el núcleo ha subido) la conexión vuelve a decir lo de siempre: el progreso va en su panel,
// con sus avisos en español y sin los códigos de la nube.

import { describe, expect, it } from "vitest";

import type { SubidaNubeEstado } from "@tpv/contracts";

import { avisosDeSubida, textoDeConexion } from "../src/features/configuracion/sections/textoConexion";

const subiendo: SubidaNubeEstado = {
	estado: "subiendo",
	fase: "imprescindible",
	filas_leidas: 1200,
	filas_total: 50_000,
	tablas_pendientes: 12,
	filas_por_revisar: 0,
	reintentando: false,
	tablas_fallidas: 0,
};

describe("DO-SUBIDA · el texto de la conexión", () => {
	it("con los Handy retenidos por la subida, dice que se devuelven los datos y que se sigue cobrando", () => {
		const t = textoDeConexion("conectado", 0, true, subiendo);
		expect(t.titulo).toBe("Devolviendo los datos a la nube…");
		expect(t.desc).toContain("Los Handy esperan a que llegue lo imprescindible");
		expect(t.desc).toContain("sigue cobrando con normalidad");
		expect(t.tono).toBe("aviso");
	});

	it("con los Handy sueltos, lo de siempre: el progreso va en su panel", () => {
		expect(textoDeConexion("conectado", 0, false, subiendo)).toEqual(textoDeConexion("conectado", 0, false, null));
		expect(textoDeConexion("conectado", 0, false, subiendo).titulo).toBe("Al día");
	});

	it("sin subida, o ya entregada a la nube, la retención es la de ponerse al día", () => {
		expect(textoDeConexion("conectado", 3, true, null).titulo).toBe("Subiendo cambios (3)…");
		expect(textoDeConexion("conectado", 0, true, { ...subiendo, estado: "contrastando" }).titulo).toBe("Poniéndose al día…");
	});

	it("sin conexión, manda el estado de la conexión", () => {
		expect(textoDeConexion("reintentando", 0, true, subiendo).titulo).toBe("Sin conexión");
	});
});

describe("DO-SUBIDA · los avisos del panel de la subida", () => {
	it("sin nada que avisar, ninguno", () => {
		expect(avisosDeSubida(subiendo)).toEqual([]);
	});

	it("una parte que la nube no admite se dice aparte, sin código y sin prometer que se reintenta", () => {
		const avisos = avisosDeSubida({ ...subiendo, tablas_fallidas: 1 });
		expect(avisos).toHaveLength(1);
		expect(avisos[0].texto).toContain("la revisará la comprobación con la nube");
		expect(avisos[0].texto).not.toMatch(/reintenta|_/);
	});

	it("un rechazo que se reintenta lo dice en español, sin el código de la nube", () => {
		const avisos = avisosDeSubida({ ...subiendo, reintentando: true, filas_por_revisar: 1200 });
		expect(avisos.map((a) => a.tono)).toEqual(["info", "aviso"]);
		expect(avisos[1].texto).toBe("La nube no ha aceptado el último envío. Se reintenta solo en unos segundos.");
		expect(avisos.every((a) => !/[a-z]+_[a-z]+/.test(a.texto))).toBe(true);
	});
});
