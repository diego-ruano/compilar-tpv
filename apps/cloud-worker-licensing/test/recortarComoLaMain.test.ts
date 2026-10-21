// test/recortarComoLaMain.test.ts
//
// VALID-01: lo que normaliza una entrada del negocio se recorta con `recortar` (lib/texto.ts), que
// quita lo mismo que `str::trim` en la Main. El `.trim()` de JavaScript quita además U+FEFF y deja
// U+0085: un `.trim()` nuevo en un schema o en un comando volvería a hacer que un texto valga en un
// lado y no en el otro, y ningún otro test lo vería salvo que alguien escribiera ese caso. Si salta,
// cambia el `.trim()` por `recortar`.

import { describe, expect, it } from "vitest";

import { recortar } from "../src/lib/texto";

const fuentes = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** Los dominios del negocio, que tienen su `validar` en la Main; los de la base central, no. */
const DOMINIOS = [
	"clientes", "configuracion", "cuentas", "inventario", "login", "mesas", "notificaciones",
	"proveedores", "reservas", "reservas_web", "tareas", "trabajadores", "venta_rapida",
];

const vigilados = Object.keys(fuentes).filter(
	(ruta) =>
		DOMINIOS.some((d) => new RegExp(`/domains/${d}/[^/]+\\.(schemas|commands|routes)\\.ts$`).test(ruta)) ||
		/\/lib\/(fechas|pago)\.ts$/.test(ruta),
);

describe("las entradas del negocio se recortan como en la Main", () => {
	it("encuentra los ficheros que vigila", () => {
		expect(vigilados.length).toBeGreaterThan(30);
	});

	it("ninguno usa el .trim() de JavaScript", () => {
		const conTrim = vigilados.filter((ruta) => /\.trim\(\)/.test(fuentes[ruta]));
		expect(conTrim).toEqual([]);
	});

	it("recortar quita U+0085 y deja U+FEFF, como str::trim", () => {
		expect(recortar("\u0085 \t Ana 　\n")).toBe("Ana");
		expect(recortar("﻿Ana")).toBe("﻿Ana");
		expect(recortar(" a b ")).toBe("a b");
	});
});
