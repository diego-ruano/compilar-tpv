// src/lib/texto.ts
//
// VALID-01: el texto que llega se recorta como en la Main. Allí es `str::trim` de Rust, que quita lo
// que Unicode marca como espacio (la propiedad `White_Space`). El `.trim()` de JavaScript no es lo
// mismo: quita además U+FEFF y deja U+0085, y con eso un texto valía en un lado y no en el otro, o se
// guardaba distinto. Se usa en todo lo que normaliza una entrada en los dominios del negocio: los
// schemas (`.overwrite(recortar)` en vez de `.trim()`), los comandos y lo que leen las rutas.

const ESPACIO = /^\p{White_Space}$/u;

/**
 * Quita los espacios de los dos extremos, como `str::trim` de Rust. Se recorre desde cada extremo en
 * vez de usar `/\p{White_Space}+$/`, que con muchos espacios seguidos en medio del texto tarda un
 * tiempo cuadrático. Todo lo que es `White_Space` cabe en una unidad UTF-16.
 */
export function recortar(texto: string): string {
	let inicio = 0;
	let fin = texto.length;
	while (inicio < fin && ESPACIO.test(texto[inicio])) inicio++;
	while (fin > inicio && ESPACIO.test(texto[fin - 1])) fin--;
	return texto.slice(inicio, fin);
}
