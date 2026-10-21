// test/recortarComoLaMain.test.ts
//
// VALID-01: lo que normaliza una entrada del negocio se recorta con `recortar` (lib/texto.ts), que
// quita lo mismo que `str::trim` en la Main. El `.trim()` de JavaScript quita además U+FEFF y deja
// U+0085: un `.trim()` nuevo en un schema o en un comando volvería a hacer que un texto valga en un
// lado y no en el otro, y ningún otro test lo vería salvo que alguien escribiera ese caso. Si salta,
// cambia el `.trim()` por `recortar`.

import { describe, expect, it } from "vitest";

import { hashPin, verifyPin } from "../src/domains/login/login.crypto";
import { parseId } from "../src/lib/rutas";
import { recortar } from "../src/lib/texto";

const fuentes = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** Los dominios del negocio, los que tienen su espejo en la Main; los de la base central, no. */
const DOMINIOS = [
	"clientes", "configuracion", "cuentas", "inventario", "login", "mesas", "notificaciones",
	"proveedores", "reservas", "reservas_web", "stats", "tareas", "trabajadores", "venta_rapida",
];

const vigilados = Object.keys(fuentes).filter(
	(ruta) =>
		DOMINIOS.some((d) => new RegExp(`/domains/${d}/[^/]+\\.ts$`).test(ruta)) ||
		/\/lib\/(fechas|pago|rutas)\.ts$/.test(ruta),
);

describe("las entradas del negocio se recortan como en la Main", () => {
	it("encuentra los ficheros que vigila", () => {
		expect(vigilados.length).toBeGreaterThan(50);
	});

	it("ninguno usa el .trim() de JavaScript", () => {
		const conTrim = vigilados.filter((ruta) => /\.trim\(\)/.test(fuentes[ruta]));
		expect(conTrim).toEqual([]);
	});

	it("recortar quita U+0085 y deja U+FEFF, como str::trim", () => {
		expect(recortar("\u0085 \t Ana \u3000\n")).toBe("Ana");
		expect(recortar("\ufeffAna")).toBe("\ufeffAna");
		expect(recortar(" a b ")).toBe("a b");
		expect(recortar(" \u0085 ")).toBe("");
	});

	it("con muchos espacios en medio tarda lo que tarda recorrerlo, no su cuadrado", () => {
		const largo = "A" + " ".repeat(200_000) + "B";
		const desde = Date.now();
		expect(recortar(` ${largo} `)).toBe(largo);
		// Con /\p{White_Space}+$/ eran segundos; recorriendo desde los extremos, milisegundos.
		expect(Date.now() - desde).toBeLessThan(1000);
	});

	it("un id de la ruta se recorta igual que el del cuerpo", () => {
		expect(parseId(" \u0085c1 ")).toBe("c1");
		expect(parseId("\ufeffc1")).toBe("\ufeffc1");
		expect(parseId(" \u0085 ")).toBeNull();
	});

	it("el PIN se recorta como en la Main: U+0085 sobra y U+FEFF forma parte de él", async () => {
		await expect(verifyPin("\u00851234\u0085", await hashPin("1234"))).resolves.toBeUndefined();
		await expect(verifyPin("1234", await hashPin("\ufeff1234"))).rejects.toThrow("PIN incorrecto");
	});
});
