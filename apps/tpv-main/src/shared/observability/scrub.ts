// shared/observability/scrub.ts
//
// Filtro de datos personales (scrubbing) de la Webview antes de que un error salga hacia Sentry
// (OBS-01). `sendDefaultPii=false` sólo cubre el contexto automático de Sentry (usuario, request):
// no toca lo que compone la app —mensajes de excepción, datos extra ni breadcrumbs, que es donde
// acaba la consola entera, con sus argumentos—. Un registro de errores no necesita el DNI ni el IBAN
// de nadie, así que lo que tenga forma de dato personal se sustituye por un marcador.
//
// Es defensa en profundidad: el core de Rust vuelve a filtrar en su `before_send`, pero hacerlo aquí
// evita que el dato viaje siquiera por el puente JS→Rust.
//
// ⚠️ Hay TRES copias de estas reglas, porque no pueden compartir código: ésta, la del core de Rust
// (`crates/tpv-telemetry/src/scrub.rs`) y la del worker (`apps/cloud-worker-licensing/src/
// observability/scrub.ts`). Lo que las mantiene iguales es la tabla de casos que leen los tests de las
// tres, `crates/tpv-telemetry/src/scrub_casos.json`: si cambias una regla, añade ahí el caso y las
// otras dos copias fallarán hasta que las iguales.
//
// Lo que una expresión regular NO puede hacer es reconocer un nombre o una dirección. Por eso un
// mensaje de error no se compone con ellos: esto es la red, no la regla.

type Regla = { re: RegExp; con: string };

/** AUD-32: los pasos de los recorridos escritos a mano. Sólo lo pasan los tests (`scrubContando`). */
export type Contador = { pasos: number };

/**
 * Cómo se filtra cada cadena de un objeto o de un evento: por defecto, `scrub`. El worker le pone
 * además su tope (`observability/tope.ts`), que recibe la cadena y el filtro.
 */
export type Filtro = (texto: string, filtrar: (texto: string) => string) => string;
const sinTope: Filtro = (texto, filtrar) => filtrar(texto);

// Los blancos, escritos uno a uno y los mismos en las tres copias. `\s` no vale: en JavaScript incluye
// U+FEFF y no U+0085, y en Rust, al revés.
//
// Alrededor de un separador (`token = x`) cuentan todos los de los dos: lo que Unicode marca como espacio,
// más U+FEFF. Que sobren sólo hace que se reconozcan más claves.
const BLANCO_SIN_ESPACIO = String.raw`\t-\r\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff`;
const EN_BLANCO = " " + BLANCO_SIN_ESPACIO;
const B = `[${EN_BLANCO}]`;
// Lo que termina un valor, en cambio, sólo los que lo terminaban en las dos copias (sin U+0085 ni
// U+FEFF): que falte uno sólo alarga lo que se tapa, y que sobre dejaría a la vista el resto del valor.
// Y lo mismo en lo que el filtro deja sin tapar a propósito (los intervalos de diagnóstico, como
// `hash: …`): sólo los blancos que lo dejaban sin tapar en las dos copias (`C`).
const FIN_DE_VALOR = String.raw` \t-\r\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000`;
const COMUN_SIN_ESPACIO = FIN_DE_VALOR.slice(1);
const C = `[${FIN_DE_VALOR}]`;

// Las tres últimas no llevan «secreto» en el nombre: la clave con la que se cifran los datos del
// personal (`fieldDek`, que viaja en la respuesta de la activación), el hash de un PIN y el ticket de
// un solo uso del WebSocket. `ticket` sólo cuenta como clave con `:` o `=` detrás, o como nombre de
// campo: «ticket 2027/000001» y `numero_ticket` no se tocan.
//
// Sin distinguir mayúsculas de minúsculas, pero sólo las de ASCII, igual en las tres copias: con la
// bandera `i` y sin la `u`, una letra ASCII del patrón no casa con una de fuera (`k` no casa con el
// kelvin, U+212A, ni `s` con la ese larga, U+017F). La eñe va escrita en sus dos cajas.
const SECRET_KEYS = String.raw`authorization|auth|password|passwd|pwd|contrase[nñÑ]a|secret|token|api[_-]?key|apikey|pin|otp|(?:access|refresh|id)[_-]?token|client[_-]?secret|field[_-]?dek|password[_-]?hash|ticket`;
// Una captura acotada puede terminar en mitad del valor o de un escape.
const SECRET_VALUE = String.raw`(?:"(?:\\[\s\S]|[^"\\])*(?:"|\\?$)|'(?:\\[\s\S]|[^'\\])*(?:'|\\?$)|[^${FIN_DE_VALOR},;&}"']+)`;

// AUD-32: el filtro recibe cadenas que elige quien llama (una ruta, un `op_id`, los campos de la
// telemetría), así que tiene que costar un tiempo lineal, y este motor retrocede: una repetición sin
// tope que puede empezar en cada posición de un tramo (`x+@`, `eyJx+\.`) lo recorre entero desde cada
// una. Por eso el correo lleva las cotas de lo que reconoce (64 y 253 caracteres a cada lado de la
// arroba y 63 de dominio final, RFC 5321 y 1035), el separador de `diagnostico` no puede repartirse
// de dos maneras, y lo que no cabe en una expresión acotada se recorre a mano: los tres tramos de un
// JWT (`redactarJwt`) y los separadores pegados a un número (`redactNumbers`).
//
// Todas las expresiones regulares del filtro están aquí, con nombre. `scrubCoste.test.ts`, en el
// worker, lee sus fuentes: una repetición sin tope (`*`, `+`, `{n,}`) sólo vale si está en su lista
// de excepciones, con el porqué escrito, y comprueba que el filtro no ejecuta ninguna otra.
export const EXPRESIONES = {
	// RI-42: sólo Bearer/Basic añaden una segunda palabra. El marcador no consume diagnóstico.
	autorizacion: new RegExp(String.raw`\b(authorization|auth)\b${B}*[:=]${B}*(?:(?:bearer|basic)${B}+)?[^${FIN_DE_VALOR},;&}"']+`, "gi"),
	// Esquemas de credencial sueltos (`Bearer <tok>` / `Basic <tok>`).
	esquema: new RegExp(String.raw`\b(?:bearer|basic)${B}+[A-Za-z0-9._~+/=\-]{4,}`, "gi"),
	// RI-42: claves JSON o entre comillas y valores con espacios/escapes.
	secretoEntreComillas: new RegExp(String.raw`(["'])(${SECRET_KEYS})["']${B}*[:=]${B}*${SECRET_VALUE}`, "gi"),
	secreto: new RegExp(String.raw`\b(${SECRET_KEYS})\b${B}*[:=]${B}*${SECRET_VALUE}`, "gi"),
	// Correos. De una parte local más larga se redactan sus últimos 64 caracteres.
	correo: /[A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9.\-]{1,253}\.[A-Za-z]{2,63}/g,
	// IBAN español, en cualquier caja, junto o agrupado con espacios o guiones.
	ibanEs: /\bES[0-9]{2}(?:[ \-]?[0-9]{4}){5}\b/gi,
	// IBAN de cualquier país, en mayúsculas. Sólo en mayúsculas a propósito: en minúsculas, un hash o
	// un identificador hexadecimal de 15 a 34 caracteres que empiece por dos letras tendría su forma.
	iban: /\b[A-Z]{2}[0-9]{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g,
	// Número de afiliación a la Seguridad Social: 2 + 8 + 2 cifras, juntas o separadas.
	nss: /\b[0-9]{2}[ /\-]?[0-9]{8}[ /\-]?[0-9]{2}\b/g,
	// DNI y NIE, con puntos, guiones o espacios, en cualquier caja. Un CIF (letra delante y cifras
	// pegadas) no encaja a propósito: es de una empresa, no de una persona.
	dni: /\b(?:[XYZ][ \-]?)?[0-9]{1,2}(?:[. ]?[0-9]{3}){2}[ \-]?[A-Z]\b/gi,
	// RI-42: secretos/correos primero; después se protegen sólo intervalos de diagnóstico. Entre
	// `hash` y su valor van dos puntos o un igual entre blancos, o blancos con algún espacio: el
	// primer espacio es el que cuenta. Los blancos, los comunes (`C`): esto deja algo sin tapar.
	diagnostico: new RegExp(
		String.raw`\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}` +
			String.raw`|[0-9]{4}-[0-9]{2}-[0-9]{2}(?:[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.,][0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})?)?` +
			String.raw`|(?:[a-z_][a-z0-9_]*_ms|timestamp|epoch|ts)${C}*[:=]${C}*[0-9]{10,16}` +
			String.raw`|(?:hash|huella|event(?:_id)?)(?:${C}*[:=]|[${COMUN_SIN_ESPACIO}]*[ ])${C}*[a-f0-9]{16,128})\b`,
		"gi",
	),
	tarjetas: /[0-9](?:[ .\-]?[0-9]){12,18}/g,
	telefonos: /(?:(?:\+34|0034|34)[ .\-]?|\(\+34\)[ ]?)?[6789](?:[ .\-]?[0-9]){8}/g,
	soloEspacios: /^ +$/,
	noCifra: /[^0-9]/g,
	claveSecreta: new RegExp(`^(${SECRET_KEYS})$`, "i"),
	claveDeTiempo: /(?:_ms$|^(?:timestamp|epoch|ts)$)/i,
	valorDeTiempo: /^[0-9]{10,16}$/,
	claveDeHuella: /^(hash|huella|event|event_id)$/i,
	valorDeHuella: /^[A-Fa-f0-9]{16,128}$/,
} as const;
const EXP = EXPRESIONES;

// El orden importa: primero lo específico, para que una regla genérica no se quede media coincidencia.
const SECRETOS: Regla[] = [
	{ re: EXP.autorizacion, con: "$1=[redacted]" },
	{ re: EXP.esquema, con: "[redacted]" },
	{ re: EXP.secretoEntreComillas, con: "$1$2$1:$1[redacted]$1" },
	{ re: EXP.secreto, con: "$1=[redacted]" },
];
const DE_CADA_FRAGMENTO: Regla[] = [
	{ re: EXP.ibanEs, con: "[iban]" },
	{ re: EXP.iban, con: "[iban]" },
	{ re: EXP.nss, con: "[nss]" },
	{ re: EXP.dni, con: "[id]" },
];

export function scrub(input: string): string {
	return scrubContando(input);
}

/** `scrub`, contando en `cuenta` los pasos de los recorridos escritos a mano. Para los tests. */
export function scrubContando(input: string, cuenta?: Contador): string {
	let out = input;
	for (const { re, con } of SECRETOS) out = out.replace(re, con);
	out = redactarJwt(out, cuenta);
	out = out.replace(EXP.correo, "[email]");
	let result = "";
	let last = 0;
	for (const match of out.matchAll(EXP.diagnostico)) {
		result += scrubFragment(out.slice(last, match.index), cuenta) + match[0];
		last = match.index + match[0].length;
	}
	return last === 0 ? scrubFragment(out, cuenta) : result + scrubFragment(out.slice(last), cuenta);
}

function scrubFragment(input: string, cuenta?: Contador): string {
	let out = input;
	for (const { re, con } of DE_CADA_FRAGMENTO) out = out.replace(re, con);
	out = redactNumbers(out, EXP.tarjetas, true, cuenta);
	return redactNumbers(out, EXP.telefonos, false, cuenta);
}

/** Letras, cifras, guion y guion bajo: lo que cabe en un tramo de un JWT. */
function esBase64Url(c: number): boolean {
	return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95;
}

/** Dónde acaba el tramo de base64url que empieza en `i` (`i` si ahí no empieza ninguno). */
function finDeTramo(input: string, i: number, cuenta?: Contador): number {
	while (i < input.length && esBase64Url(input.charCodeAt(i))) {
		i++;
		if (cuenta) cuenta.pasos++;
	}
	return i;
}

/**
 * JWT: cabecera.carga.firma en base64url, con `eyJ` al principio de la cabecera. Sustituye lo mismo
 * que `/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g`, sin cota en ningún tramo.
 *
 * Esa expresión cuesta un tiempo cuadrático en un motor que retrocede (AUD-32): prueba cada `eyJ` de
 * un tramo y desde cada uno lo recorre hasta el final. Aquí cada tramo se mira una vez: todos los
 * `eyJ` de un mismo tramo acaban donde acaba el tramo, así que lo que venga detrás (punto, carga,
 * punto, firma) vale para todos o para ninguno, y si vale, el JWT empieza en el primero. La
 * frontera es la de `\b`: el principio del tramo, o detrás de un guion.
 */
function redactarJwt(input: string, cuenta?: Contador): string {
	let result = "";
	let last = 0;
	let i = 0;
	while (i < input.length) {
		if (cuenta) cuenta.pasos++;
		if (!esBase64Url(input.charCodeAt(i))) { i++; continue; }
		const tramo = i;
		const fin = finDeTramo(input, tramo, cuenta);
		i = fin;
		let inicio = -1;
		for (let p = tramo; p + 3 < fin; p++) {
			if (cuenta) cuenta.pasos++;
			if (input.charCodeAt(p) === 101 && input.charCodeAt(p + 1) === 121 && input.charCodeAt(p + 2) === 74
				&& (p === tramo || input.charCodeAt(p - 1) === 45)) { inicio = p; break; }
		}
		if (inicio < 0 || input.charCodeAt(fin) !== 46) continue;
		const finCarga = finDeTramo(input, fin + 1, cuenta);
		if (finCarga === fin + 1 || input.charCodeAt(finCarga) !== 46) continue;
		const finFirma = finDeTramo(input, finCarga + 1, cuenta);
		if (finFirma === finCarga + 1) continue;
		result += input.slice(last, inicio) + "[jwt]";
		last = finFirma;
		i = finFirma;
	}
	return last === 0 ? input : result + input.slice(last);
}

const esPalabra = (c: string) => (c >= "0" && c <= "9") || (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_";
const esSeparador = (c: string) => c === " " || c === "." || c === "-";
const esCifra = (c: string) => c >= "0" && c <= "9";

function redactNumbers(input: string, re: RegExp, card: boolean, cuenta?: Contador): string {
	const matches = [...input.matchAll(re)];
	let result = "";
	let last = 0;
	for (let i = 0; i < matches.length; i++) {
		if (cuenta) cuenta.pasos++;
		const start = i;
		// Validar juntos los teléfonos consecutivos, sin tomar fragmentos de un número mayor.
		while (!card && i + 1 < matches.length) {
			const gap = input.slice(matches[i].index + matches[i][0].length, matches[i + 1].index);
			if (!EXP.soloEspacios.test(gap)) break;
			i++;
		}
		const first = matches[start];
		const finalMatch = matches[i];
		// Lo que hay pegado antes y después. `charAt` fuera de la cadena da "", que no es nada de esto.
		let antes = first.index - 1;
		let despues = finalMatch.index + finalMatch[0].length;
		if (esPalabra(input.charAt(antes)) || input.charAt(antes) === "+" || esPalabra(input.charAt(despues))) continue;
		// No tomar un trozo de un número mayor separado por espacios, puntos o guiones. Se mira desde
		// el número hacia fuera (AUD-32): una expresión con `$` recorría el texto anterior entero.
		while (antes >= 0 && esSeparador(input.charAt(antes))) {
			antes--;
			if (cuenta) cuenta.pasos++;
		}
		while (despues < input.length && esSeparador(input.charAt(despues))) {
			despues++;
			if (cuenta) cuenta.pasos++;
		}
		if (esCifra(input.charAt(antes)) || esCifra(input.charAt(despues))) continue;
		if (card && !luhn(first[0])) continue;
		for (let n = start; n <= i; n++) {
			result += input.slice(last, matches[n].index) + "[num]";
			last = matches[n].index + matches[n][0].length;
		}
	}
	return last === 0 ? input : result + input.slice(last);
}

function luhn(input: string): boolean {
	const digits = input.replace(EXP.noCifra, "");
	let sum = 0;
	for (let i = digits.length - 1, n = 0; i >= 0; i--, n++) {
		let digit = Number(digits[i]);
		if (n % 2 === 1) { digit *= 2; if (digit > 9) digit -= 9; }
		sum += digit;
	}
	return sum % 10 === 0;
}

function diagnosticValue(key: string, value: string): boolean {
	return (EXP.claveDeTiempo.test(key) && EXP.valorDeTiempo.test(value))
		|| (EXP.claveDeHuella.test(key) && EXP.valorDeHuella.test(value));
}

/**
 * Filtra, en el sitio, todas las cadenas de un objeto o array, a cualquier profundidad. Cada cadena
 * pasa por `filtro` (por defecto, `scrub` sin más).
 */
export function scrubDeep(value: unknown, filtro: Filtro = sinTope): void {
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			const v = value[i];
			if (typeof v === "string") value[i] = filtro(v, scrub);
			else scrubDeep(v, filtro);
		}
		return;
	}
	const obj = value as Record<string, unknown>;
	for (const k of Object.keys(obj)) {
		const v = obj[k];
		if (EXP.claveSecreta.test(k)) obj[k] = "[redacted]";
		else if (typeof v === "string") { if (!diagnosticValue(k, v)) obj[k] = filtro(v, scrub); }
		else scrubDeep(v, filtro);
	}
}

/**
 * Lo que la app puede escribir en un evento de Sentry. Estructural a propósito: así el mismo filtro
 * vale para el SDK del navegador y para el de Cloudflare sin depender de ninguno.
 */
export type EventoSentry = {
	message?: string;
	logentry?: { message?: string; params?: unknown[] };
	exception?: { values?: { value?: string }[] };
	breadcrumbs?: { message?: string; data?: unknown }[];
	extra?: unknown;
	tags?: unknown;
	request?: { url?: string; query_string?: unknown };
};

/**
 * Filtra el contenido libre de un evento antes de enviarlo: mensaje, `logentry`, valores de
 * excepción, breadcrumbs (mensaje y datos), extra, etiquetas y la URL de la petición. Cada cadena pasa
 * por `filtro` (por defecto, `scrub` sin más).
 *
 * No se tocan los campos estructurales (id del evento, release, tipo de excepción, trazas): no llevan
 * datos de nadie, y un id o una traza redactados dejan el evento inservible.
 */
export function scrubEvent<E extends EventoSentry>(event: E, filtro: Filtro = sinTope): E {
	const filtrar = (texto: string) => filtro(texto, scrub);
	if (typeof event.message === "string") event.message = filtrar(event.message);
	if (event.logentry) {
		if (typeof event.logentry.message === "string") event.logentry.message = filtrar(event.logentry.message);
		scrubDeep(event.logentry.params, filtro);
	}
	for (const exc of event.exception?.values ?? []) {
		if (typeof exc.value === "string") exc.value = filtrar(exc.value);
	}
	for (const bc of event.breadcrumbs ?? []) {
		if (typeof bc.message === "string") bc.message = filtrar(bc.message);
		scrubDeep(bc.data, filtro);
	}
	scrubDeep(event.extra, filtro);
	scrubDeep(event.tags, filtro);
	if (event.request) {
		if (typeof event.request.url === "string") event.request.url = filtrar(event.request.url);
		const q = event.request.query_string;
		if (typeof q === "string") event.request.query_string = filtrar(q);
		else scrubDeep(q, filtro);
	}
	return event;
}
