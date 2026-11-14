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

/** La comilla doble (`"`). */
const COMILLA = 34;

/**
 * AUD-33 · Quita las comillas dobles de los dos extremos: lo mismo que
 * `texto.replace(/^"+|"+$/g, "")`, para cualquier texto. Esa expresión, en este motor, prueba
 * `"+$` desde cada comilla de una racha interior y la recorre entera desde cada una: el cuadrado de
 * su longitud, y corría sobre la firma y la clave del dispositivo antes de saber quién llamaba.
 * Aquí se recorre desde cada extremo, como `recortar`, sin expresiones regulares: cada carácter se
 * mira como mucho una vez.
 */
export function quitarComillas(texto: string): string {
	let inicio = 0;
	let fin = texto.length;
	while (inicio < fin && texto.charCodeAt(inicio) === COMILLA) inicio++;
	while (fin > inicio && texto.charCodeAt(fin - 1) === COMILLA) fin--;
	return texto.slice(inicio, fin);
}

/**
 * Lo que ocupa un texto en UTF-8, sin codificarlo: uno por carácter ASCII, dos hasta U+07FF, tres en
 * el resto del plano básico (también un sustituto suelto, que se codifica como U+FFFD) y cuatro por
 * cada par de sustitutos. Lo mismo que `new TextEncoder().encode(texto).byteLength`, sin la copia.
 */
export function bytesUtf8(texto: string): number {
	let bytes = 0;
	for (let i = 0; i < texto.length; i++) {
		const c = texto.charCodeAt(i);
		if (c >= 0xd800 && c <= 0xdbff && i + 1 < texto.length && (texto.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
			bytes += 4;
			i++;
		} else bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
	}
	return bytes;
}
