// src/observability/tope.ts
//
// AUD-32 — el tope común de lo que el worker manda a telemetría.
//
// El filtro de datos personales (`scrub.ts`) corre síncrono sobre cada cadena de cada evento, antes
// de contestar, y muchas las elige quien llama: los campos de un lote de telemetría, la ruta de una
// petición, la clave o el nombre de una operación que la Main manda por el WebSocket. Cada sitio que
// emite un evento no puede acordarse de acotar las suyas, así que va aquí, una vez, en las tres
// salidas: `ingestToAxiom` (todo evento que sale a Axiom, del worker, del `TenantHub` o de un
// dispositivo), el `beforeSend` de Sentry y el aviso que se escribe en la consola cuando Axiom
// rechaza un lote. Se acota la copia que sale, nunca el dato con el que se trabaja.
//
// Dos topes, y el orden importa:
//
//   1. **Lo que se filtra**: una cadena de hasta `MAX_FILTRADO` caracteres se filtra entera. Una más
//      larga se corta antes de filtrarla, con la cola segura de abajo: filtrarla entera costaría en
//      proporción a su tamaño, que elige quien llama.
//   2. **Lo que sale**: `MAX_BYTES` en UTF-8, la marca incluida. Se corta **después** de filtrar, y
//      cortar un texto ya filtrado no puede dejar a la vista nada que el filtro hubiera tapado. Al
//      revés sí: un JWT o un correo partidos por la mitad ya no se reconocen.

/** Lo más que ocupa en UTF-8 una cadena que sale a telemetría, con la marca. */
export const MAX_BYTES = 16 * 1024;

/** Lo más largo que se filtra entero, en caracteres de JavaScript (unidades UTF-16). */
export const MAX_FILTRADO = 64 * 1024;

/** Lo que se pone detrás de una cadena recortada. Sin cifras ni letras sueltas: el filtro no la toca. */
export const MARCA_DE_RECORTE = "…[recortado]";

export type Topes = { bytes: number; filtrado: number };
const TOPES: Topes = { bytes: MAX_BYTES, filtrado: MAX_FILTRADO };

/**
 * Filtra una cadena que va a telemetría con `filtrar`, acotando lo que se filtra y lo que sale.
 * `topes` sólo lo cambian los tests.
 */
export function acotar(texto: string, filtrar: (texto: string) => string, topes: Topes = TOPES): string {
	if (texto.length <= topes.filtrado) return ajustarABytes(filtrar(texto), topes.bytes, false);
	return ajustarABytes(filtrar(colaSegura(texto, topes.filtrado)), topes.bytes, true);
}

/**
 * Lo que queda de un texto demasiado largo para filtrarlo entero: su principio hasta el último blanco
 * que no sea un espacio (un salto de línea, un tabulador, un U+2028…) antes del tope, sin él.
 *
 * Lo que se queda es un principio del texto, y el filtro decide sobre él lo mismo que sobre el texto
 * entero salvo en lo que el corte parte. Cortar ahí no parte nada que el filtro tape:
 *
 *   - ningún dato que el filtro reconoce lleva dentro uno de esos blancos (un correo, un JWT, un
 *     número, un DNI o un IBAN se escriben, a lo sumo, con espacios, puntos, guiones o barras);
 *   - lo único que puede pasar por encima es lo que va entre una clave y su valor (`token =\n x`): lo
 *     que queda delante del corte es la clave, que no es secreta, o un valor que se tapa hasta el
 *     final (uno entre comillas sin cerrar se tapa entero);
 *   - y lo que va detrás no cambia lo que el filtro decide de lo que tiene delante: ese blanco no es
 *     una letra, ni una cifra, ni un separador de número, igual que el final del texto.
 *
 * Un espacio no vale: un teléfono, una tarjeta o un IBAN se escriben con espacios, y cortar entre sus
 * grupos deja a la vista lo que queda delante (o un teléfono entero seguido de las cifras sueltas del
 * siguiente, que ya parece parte de un número mayor y tampoco se tapa); y la palabra que cruza el
 * corte puede llevar pegado el principio de un IBAN (`"hola"ES91 2100…`). Si no hay ninguno de esos
 * blancos no queda nada, y sale sólo la marca: es un texto de más de 64 Ki caracteres en una sola
 * línea, que no manda nadie que use el programa.
 *
 * Lo vigila `test/topeDeTelemetria.test.ts`, con textos al azar cortados por todas partes.
 */
export function colaSegura(texto: string, maximo: number): string {
	for (let corte = Math.min(maximo, texto.length); corte > 0; corte--) {
		if (esBlancoQueNoEsEspacio(texto.charCodeAt(corte - 1))) return texto.slice(0, corte - 1);
	}
	return "";
}

/** Recorta un texto ya filtrado a `maximo` bytes de UTF-8, con su marca, entre caracteres completos. */
function ajustarABytes(texto: string, maximo: number, recortado: boolean): string {
	const disponible = maximo - bytesUtf8(MARCA_DE_RECORTE);
	let bytes = 0;
	let corte = -1;
	for (let i = 0; i < texto.length; ) {
		const c = texto.charCodeAt(i);
		const par = esSustitutoAlto(c) && i + 1 < texto.length && esSustitutoBajo(texto.charCodeAt(i + 1));
		const ancho = par ? 4 : c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
		if (corte < 0 && bytes + ancho > disponible) corte = i;
		bytes += ancho;
		if (bytes > maximo) break;
		i += par ? 2 : 1;
	}
	if (!recortado && bytes <= maximo) return texto;
	return texto.slice(0, corte < 0 ? texto.length : corte) + MARCA_DE_RECORTE;
}

/** Bytes que ocupa un texto en UTF-8 (un sustituto suelto, como U+FFFD: 3). */
export function bytesUtf8(texto: string): number {
	let bytes = 0;
	for (let i = 0; i < texto.length; i++) {
		const c = texto.charCodeAt(i);
		if (esSustitutoAlto(c) && i + 1 < texto.length && esSustitutoBajo(texto.charCodeAt(i + 1))) {
			bytes += 4;
			i++;
		} else bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
	}
	return bytes;
}

const esSustitutoAlto = (c: number) => c >= 0xd800 && c <= 0xdbff;
const esSustitutoBajo = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** Los blancos del filtro (lo que Unicode marca como espacio, más U+FEFF), salvo el espacio. */
function esBlancoQueNoEsEspacio(c: number): boolean {
	return (c >= 0x09 && c <= 0x0d) || c === 0x85 || c === 0xa0 || c === 0x1680
		|| (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f
		|| c === 0x205f || c === 0x3000 || c === 0xfeff;
}
