// test/resumenCubos.test.ts
//
// El resumen por cubos del worker contra la tabla que comparte con la Main
// (`crates/tpv-domain/src/verificacion_casos.json`; su espejo, `crates/tpv-domain/src/contraste.rs`).
//
// Si los dos lados no escriben la misma fila con los mismos bytes, ningún cubo cuadra y el contraste
// baja la ventana entera cada día. No pueden compartir código, así que comparten los casos: la forma
// canónica de cada valor, el hash, el cubo de una clave y el resumen de una tabla entera. Los
// resultados de la tabla salen de una tercera implementación (con BigInt), no de ninguna de las dos.

import { describe, expect, it } from "vitest";

import casosJson from "../../../crates/tpv-domain/src/verificacion_casos.json?raw";
import {
	Canonico,
	FiltroDeCubos,
	MAX_CUBOS,
	Resumidor,
	SumaDeTramo,
	cubosPara,
	cubosValidos,
	fnv1a64,
	hex64,
} from "../src/domains/sync/resumenCubos";

type Etiquetado = { entero: string } | { real: string } | { blob: string };
type ValorDeCaso = null | number | string | Etiquetado;

const casos = JSON.parse(casosJson) as {
	fnv1a64: { texto: string; hash: string }[];
	valores: { valor: ValorDeCaso; bytes: string }[];
	filas: { fila: ValorDeCaso[]; bytes: string; hash: string }[];
	cubos: { clave: ValorDeCaso[]; hash: string; cubo: Record<string, number> }[];
	cubos_para: { filas: number; cubos: number }[];
	tramos: { descripcion: string; filas: ValorDeCaso[][]; n: number; suma: string }[];
	resumenes: {
		descripcion: string;
		claves: number[];
		cubos: number;
		filas: ValorDeCaso[][];
		cuentas: number[];
		sumas: string[];
	}[];
};

const enHex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const deHex = (texto: string) => Uint8Array.from(texto.match(/../g) ?? [], (x) => parseInt(x, 16));

/**
 * Un valor de la tabla, como lo entregaría el SQLite del DO: un `INTEGER` llega como `number` (y uno
 * de más de 53 bits, ya redondeado), y un blob, como `ArrayBuffer`.
 */
function delDo(v: ValorDeCaso): unknown {
	if (v === null || typeof v !== "object") return v;
	if ("entero" in v) return Number(BigInt(v.entero));
	if ("real" in v) return v.real === "inf" ? Infinity : v.real === "-inf" ? -Infinity : v.real === "-0" ? -0 : Number(v.real);
	return deHex(v.blob).buffer;
}

function canonica(valores: ValorDeCaso[]): { bytes: string; hash: string } {
	const c = new Canonico();
	for (const v of valores) c.valor(delDo(v));
	const bytes = enHex(c.escrito());
	c.hash();
	return { bytes, hash: hex64(c.alto, c.bajo) };
}

describe("el resumen por cubos cuadra con la tabla compartida", () => {
	it("el hash es FNV-1a de 64 bits", () => {
		const utf8 = new TextEncoder();
		const mitades = new Uint32Array(2);
		for (const { texto, hash } of casos.fnv1a64) {
			const bytes = utf8.encode(texto);
			fnv1a64(bytes, bytes.length, mitades);
			expect(hex64(mitades[0], mitades[1]), JSON.stringify(texto)).toBe(hash);
		}
		// Sólo cuentan los `n` primeros bytes.
		const foobar = utf8.encode("foobar y lo que sobra");
		fnv1a64(foobar, 6, mitades);
		expect(hex64(mitades[0], mitades[1])).toBe("85944171f73967e8");
	});

	// DO-SUBIDA: un tramo del histórico de la subida completa se compara por sus filas y la suma de
	// sus huellas, igual que la Main (`tpv_domain::contraste::suma_de_huellas`).
	it("la suma de un tramo es la de la tabla compartida", () => {
		for (const caso of casos.tramos) {
			const s = new SumaDeTramo();
			for (const fila of caso.filas) s.fila(fila.map(delDo));
			expect(s.n, caso.descripcion).toBe(caso.n);
			expect(s.suma, caso.descripcion).toBe(caso.suma);
		}
	});

	it("cada valor tiene una sola forma de escribirse", () => {
		for (const { valor, bytes } of casos.valores) {
			expect(canonica([valor]).bytes, JSON.stringify(valor)).toBe(bytes);
		}
	});

	it("una fila es la concatenación de sus valores", () => {
		for (const { fila, bytes, hash } of casos.filas) {
			expect(canonica(fila), JSON.stringify(fila)).toEqual({ bytes, hash });
		}
	});

	it("el cubo sale de los bits altos de la mezcla del hash de la clave", () => {
		for (const { clave, hash, cubo } of casos.cubos) {
			expect(canonica(clave).hash, JSON.stringify(clave)).toBe(hash);
			const fila = clave.map(delDo);
			const posiciones = fila.map((_, i) => i);
			for (const [cubos, esperado] of Object.entries(cubo)) {
				const n = Number(cubos);
				// El filtro pide un cubo y sólo ése: la fila cae en el esperado y en ningún otro.
				for (let c = 0; c < n; c++) {
					expect(new FiltroDeCubos(n, [c]).pide(fila, posiciones), `${JSON.stringify(clave)} en ${n}`).toBe(
						c === esperado,
					);
				}
			}
		}
	});

	it("el resumen de una tabla es el de la tabla compartida", () => {
		for (const caso of casos.resumenes) {
			const r = new Resumidor();
			for (const fila of caso.filas) r.fila(fila.map(delDo), caso.claves);
			expect(r.filas).toBe(caso.filas.length);
			expect(r.resumen(caso.cubos), caso.descripcion).toEqual({
				cubos: caso.cubos,
				cuentas: caso.cuentas,
				sumas: caso.sumas,
			});
		}
	});

	it("el orden de las filas no cambia el resumen", () => {
		const caso = casos.resumenes[3];
		const resumir = (filas: ValorDeCaso[][]) => {
			const r = new Resumidor();
			for (const fila of filas) r.fila(fila.map(delDo), caso.claves);
			return r.resumen(caso.cubos);
		};
		expect(resumir([...caso.filas].reverse())).toEqual(resumir(caso.filas));
	});

	it("claves que sólo se diferencian al final se reparten por todos los cubos", () => {
		// Con los bits altos del FNV-1a sin mezclar, 180 claves así caían en 2 de los 256 cubos.
		const r = new Resumidor();
		const ocupados = new Set<number>();
		for (let i = 0; i < 180; i++) ocupados.add(r.fila([`d-${String(i).padStart(4, "0")}`], [0]));
		expect(ocupados.size).toBeGreaterThan(100);
		expect(Math.max(...r.resumen(16).cuentas)).toBeLessThanOrEqual(25);
	});

	it("plegar el resumen de 256 cubos da el de menos cubos", () => {
		// Las mismas filas, resumidas en 16 y en 256 (dos casos de la tabla): lo de 16 es lo de 256
		// sumado de dieciséis en dieciséis.
		const [en16, en256] = [casos.resumenes[3], casos.resumenes[4]];
		const r = new Resumidor();
		for (const fila of en256.filas) r.fila(fila.map(delDo), en256.claves);
		expect(r.resumen(256).cuentas).toEqual(en256.cuentas);
		expect(r.resumen(16)).toEqual({ cubos: 16, cuentas: en16.cuentas, sumas: en16.sumas });
		const plegadas = new Array(16).fill(0);
		en256.cuentas.forEach((n, i) => (plegadas[i >>> 4] += n));
		expect(plegadas).toEqual(en16.cuentas);
	});
});

describe("cuántos cubos lleva una tabla", () => {
	it("unas 32 filas por cubo, en potencias de dos y hasta 256", () => {
		expect(casos.cubos_para.length).toBeGreaterThan(5);
		for (const { filas, cubos } of casos.cubos_para) expect(cubosPara(filas), `${filas} filas`).toBe(cubos);
	});

	it("sólo valen las potencias de dos hasta el máximo", () => {
		for (const n of [1, 2, 4, 8, 16, 32, 64, 128, 256]) expect(cubosValidos(n), String(n)).toBe(true);
		for (const n of [0, -1, 3, 6, 100, 257, 512, 1.5, Number.NaN, "16", null, undefined]) {
			expect(cubosValidos(n), String(n)).toBe(false);
		}
		expect(MAX_CUBOS).toBe(256);
	});

	it("un filtro no pide lo que no es un cubo de la tabla", () => {
		const fila = ["z1"];
		const filtro = new FiltroDeCubos(4, [-1, 4, 1.5, "0", null, Number.NaN]);
		expect(filtro.pide(fila, [0])).toBe(false);
		// Y con todos los cubos pedidos, cualquier fila entra.
		expect(new FiltroDeCubos(4, [0, 1, 2, 3]).pide(fila, [0])).toBe(true);
	});
});

