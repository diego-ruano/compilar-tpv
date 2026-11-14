// src/shared/lib/busqueda.ts
//
// Lo que teclea el usuario en un buscador se compara **sin acentos y sin distinguir mayúsculas**,
// también en las listas que filtra la propia pantalla (Proveedores, Clientes, los tickets de la
// barra): «café» encuentra «CAFÉ Solo» y «CAÑA», «Caña». Es la regla de los buscadores que van a la
// base (en la Main, `tpv_domain::busqueda`; en el worker, `lib/busqueda.ts`), con la misma tabla
// (`crates/tpv-domain/src/busqueda_casos.json`, que lee `test/busqueda.test.ts`): sólo las letras
// ASCII pasan a minúscula, como hace `lower()` de SQLite, y se pliegan las de la tabla, ni una más.
// Así una lista filtrada aquí y una buscada en la base encuentran lo mismo.

/** Cada letra base con las que se le pliegan; las mayúsculas, porque sólo bajan las ASCII. */
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
const ESPACIO = /^\p{White_Space}$/u;

/**
 * Quita de los extremos lo que Unicode marca como espacio, como `str::trim` en la Main y `recortar`
 * en el worker. El `.trim()` de JavaScript quita además U+FEFF y deja U+0085, y lo tecleado se
 * buscaría distinto en la pantalla que en la base.
 */
function recortar(texto: string): string {
	let inicio = 0;
	let fin = texto.length;
	while (inicio < fin && ESPACIO.test(texto[inicio])) inicio++;
	while (fin > inicio && ESPACIO.test(texto[fin - 1])) fin--;
	return texto.slice(inicio, fin);
}

/** El texto como se compara. Lo que no está en las tablas, tal cual. */
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
 * Lo que se ha tecleado, recortado y normalizado. `null` si no queda nada: entonces no se filtra,
 * igual que con el buscador vacío (también con sólo acentos sueltos).
 */
export function textoABuscar(texto: string | null | undefined): string | null {
	return normalizarBusqueda(recortar(texto ?? "")) || null;
}

/** ¿Aparece lo buscado (ya pasado por `textoABuscar`) en alguno de los textos? */
export function contiene(buscado: string, ...textos: (string | null | undefined)[]): boolean {
	return textos.some((t) => t != null && normalizarBusqueda(t).includes(buscado));
}
