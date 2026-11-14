// src/lib/busqueda.ts
//
// Lo que teclea el usuario en un buscador se compara **sin acentos y sin distinguir mayúsculas**:
// «café» encuentra «CAFÉ Solo» y «CAÑA» encuentra «Caña». Espejo de `tpv_domain::busqueda` y de
// `tpv-infra-sqlite/src/busqueda.rs` en la Main, con los casos que comparten en
// `crates/tpv-domain/src/busqueda_casos.json` (`test/busquedaSinAcentos.test.ts`).
//
// Se busca con `instr(${normalizada(columna)}, ?) > 0` y el parámetro `normalizarBusqueda(texto)`.
// La columna la normaliza SQLite y el texto este código, y los dos tienen que decir lo mismo: por
// eso aquí sólo baja a minúscula lo que baja `lower()` de SQLite (las letras ASCII) y se pliega lo
// que pliega la expresión, ni una letra más. Un `toLowerCase()` bajaría también la «Ø», que en la
// columna se quedaría como está, y la búsqueda dejaría de encontrar lo que tiene delante.
//
// El SQLite del Durable Object no admite funciones propias, así que la expresión es SQL corriente
// (`lower` y `replace` anidados), la misma y en el mismo orden que la de la Main.

import { recortar } from "./texto";

/** Cada letra base con las que se le pliegan; las mayúsculas, porque `lower()` sólo baja las ASCII. */
export const PLIEGUES: readonly (readonly [string, string])[] = [
	["a", "áàâäãÁÀÂÄÃ"],
	["e", "éèêëÉÈÊË"],
	["i", "íìîïÍÌÎÏ"],
	["o", "óòôöõÓÒÔÖÕ"],
	["u", "úùûüÚÙÛÜ"],
	["n", "ñÑ"],
	["c", "çÇ"],
];

/** Las marcas combinantes de esos acentos, que se quitan: un texto puede llegar descompuesto. */
export const SE_QUITAN: readonly string[] = ["̀", "́", "̂", "̃", "̈", "̧"];

const BASE = new Map<string, string>(PLIEGUES.flatMap(([base, de]) => [...de].map((letra) => [letra, base] as const)));
const QUITAR = new Set(SE_QUITAN);

/** El texto con el que se busca, como queda la columna en SQL. Lo que no está en las tablas, tal cual. */
export function normalizarBusqueda(texto: string): string {
	let out = "";
	for (const c of texto) {
		if (c >= "A" && c <= "Z") out += c.toLowerCase();
		else if (QUITAR.has(c)) continue;
		else out += BASE.get(c) ?? c;
	}
	return out;
}

/**
 * El texto que se busca, recortado como en la Main y normalizado. `null` si no queda nada: entonces
 * no se filtra (o no se busca), igual que con un buscador vacío. Espejo de `texto_a_buscar`.
 */
export function textoABuscar(texto: string | null | undefined): string | null {
	return normalizarBusqueda(recortar(texto ?? "")) || null;
}

/**
 * `expr` (una columna o una concatenación de columnas) como queda para buscar en ella: `lower()` y
 * un `replace()` por cada letra y cada marca. Las marcas van como `char(n)`: sueltas dentro de un
 * literal no se verían.
 */
export function normalizada(expr: string): string {
	let sql = `lower(${expr})`;
	for (const [base, de] of PLIEGUES) {
		for (const letra of de) sql = `replace(${sql},'${letra}','${base}')`;
	}
	for (const marca of SE_QUITAN) sql = `replace(${sql},char(${marca.codePointAt(0)}),'')`;
	return sql;
}
