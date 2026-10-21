// src/lib/texto.ts
//
// VALID-01: el texto que llega se recorta como en la Main. Allí es `str::trim` de Rust, que quita lo
// que Unicode marca como espacio (la propiedad `White_Space`). El `.trim()` de JavaScript no es lo
// mismo: quita además U+FEFF y deja U+0085, y con eso un texto valía en un lado y no en el otro, o se
// guardaba distinto. Se usa en todo lo que normaliza una entrada que la Main normaliza también:
// los schemas (`.overwrite(recortar)` en vez de `.trim()`) y lo que vuelven a recortar los comandos.

/** Quita los espacios de los dos extremos, como `str::trim` de Rust. */
export function recortar(texto: string): string {
	return texto.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
}
