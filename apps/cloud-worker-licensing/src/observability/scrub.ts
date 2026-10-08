// src/observability/scrub.ts
//
// Filtro de datos personales (scrubbing) del worker antes de que un error salga hacia Sentry
// (OBS-01). `sendDefaultPii: false` sólo quita el contexto automático (cabeceras, cookies, IP): no
// toca el mensaje de una excepción, los breadcrumbs ni los datos extra, y un error de una ruta de
// licencias o de trabajadores puede llevar un correo, un DNI o un IBAN dentro. Un registro de errores
// no necesita ninguno, así que lo que tenga forma de dato personal se sustituye por un marcador.
//
// La salida común a Axiom también aplica este filtro: los lotes del dispositivo llegan filtrados,
// pero los eventos del worker/DO pueden incluir texto libre de errores.
//
// ⚠️ Hay TRES copias de estas reglas, porque no pueden compartir código: ésta, la del core de Rust
// (`crates/tpv-telemetry/src/scrub.rs`) y la de la Webview (`apps/tpv-main/src/shared/observability/
// scrub.ts`). Lo que las mantiene iguales es la tabla de casos que leen los tests de las tres,
// `crates/tpv-telemetry/src/scrub_casos.json`: si cambias una regla, añade ahí el caso y las otras dos
// copias fallarán hasta que las iguales. Por debajo de esta cabecera, este fichero y el de la Webview
// son idénticos.
//
// Lo que una expresión regular NO puede hacer es reconocer un nombre o una dirección. Por eso un
// mensaje de error no se compone con ellos: esto es la red, no la regla.

type Regla = { re: RegExp; con: string };

const SECRET_KEYS = String.raw`authorization|auth|password|passwd|pwd|contrase(?:n|ñ)a|secret|token|api[_-]?key|apikey|pin|otp|(?:access|refresh|id)[_-]?token|client[_-]?secret`;
const SECRET_VALUE = String.raw`(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}"']+)`;
const SENSITIVE_RULES = 6;
const CLAVE_SECRETA = new RegExp(`^(${SECRET_KEYS})$`, "i");

// El orden importa: primero lo específico, para que una regla genérica no se quede media coincidencia.
const REGLAS: Regla[] = [
	// RI-42: sólo Bearer/Basic añaden una segunda palabra. El marcador no consume diagnóstico.
	{ re: /\b(authorization|auth)\b\s*[:=]\s*(?:(?:bearer|basic)\s+)?[^\s,;&}"']+/gi, con: "$1=[redacted]" },
	// Esquemas de credencial sueltos (`Bearer <tok>` / `Basic <tok>`).
	{ re: /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=\-]{4,}/gi, con: "[redacted]" },
	// RI-42: claves JSON o entre comillas y valores con espacios/escapes.
	{ re: new RegExp(String.raw`(["'])(${SECRET_KEYS})["']\s*[:=]\s*${SECRET_VALUE}`, "gi"), con: "$1$2$1:$1[redacted]$1" },
	{
		re: new RegExp(String.raw`\b(${SECRET_KEYS})\b\s*[:=]\s*${SECRET_VALUE}`, "gi"),
		con: "$1=[redacted]",
	},
	// JWT (cabecera.carga.firma en base64url).
	{ re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, con: "[jwt]" },
	// Correos.
	{ re: /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g, con: "[email]" },
	// IBAN español, en cualquier caja, junto o agrupado con espacios o guiones.
	{ re: /\bES[0-9]{2}(?:[ \-]?[0-9]{4}){5}\b/gi, con: "[iban]" },
	// IBAN de cualquier país, en mayúsculas. Sólo en mayúsculas a propósito: en minúsculas, un hash o
	// un identificador hexadecimal de 15 a 34 caracteres que empiece por dos letras tendría su forma.
	{ re: /\b[A-Z]{2}[0-9]{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g, con: "[iban]" },
	// Número de afiliación a la Seguridad Social: 2 + 8 + 2 cifras, juntas o separadas.
	{ re: /\b[0-9]{2}[ /\-]?[0-9]{8}[ /\-]?[0-9]{2}\b/g, con: "[nss]" },
	// DNI y NIE, con puntos, guiones o espacios, en cualquier caja. Un CIF (letra delante y cifras
	// pegadas) no encaja a propósito: es de una empresa, no de una persona.
	{ re: /\b(?:[XYZ][ \-]?)?[0-9]{1,2}(?:[. ]?[0-9]{3}){2}[ \-]?[A-Z]\b/gi, con: "[id]" },
	];

// RI-42: secretos/correos primero; después se protegen sólo intervalos de diagnóstico.
const DIAGNOSTICO = /\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9]{4}-[0-9]{2}-[0-9]{2}(?:[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.,][0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})?)?|(?:[a-z_][a-z0-9_]*_ms|timestamp|epoch|ts)\s*[:=]\s*[0-9]{10,16}|(?:hash|huella|event(?:_id)?)\s*[:= ]\s*[a-f0-9]{16,128})\b/gi;
const TARJETAS = /[0-9](?:[ .\-]?[0-9]){12,18}/g;
const TELEFONOS = /(?:(?:\+34|0034|34)[ .\-]?|\(\+34\)[ ]?)?[6789](?:[ .\-]?[0-9]){8}/g;

export function scrub(input: string): string {
	let out = input;
	for (const { re, con } of REGLAS.slice(0, SENSITIVE_RULES)) out = out.replace(re, con);
	let result = "";
	let last = 0;
	for (const match of out.matchAll(DIAGNOSTICO)) {
		result += scrubFragment(out.slice(last, match.index)) + match[0];
		last = match.index + match[0].length;
	}
	return last === 0 ? scrubFragment(out) : result + scrubFragment(out.slice(last));
}

function scrubFragment(input: string): string {
	let out = input;
	for (const { re, con } of REGLAS.slice(SENSITIVE_RULES)) out = out.replace(re, con);
	out = redactNumbers(out, TARJETAS, true);
	return redactNumbers(out, TELEFONOS, false);
}

function redactNumbers(input: string, re: RegExp, card: boolean): string {
	const matches = [...input.matchAll(re)];
	let result = "";
	let last = 0;
	for (let i = 0; i < matches.length; i++) {
		const start = i;
		// Validar juntos los teléfonos consecutivos, sin tomar fragmentos de un número mayor.
		while (!card && i + 1 < matches.length) {
			const gap = input.slice(matches[i].index + matches[i][0].length, matches[i + 1].index);
			if (!/^ +$/.test(gap)) break;
			i++;
		}
		const first = matches[start];
		const finalMatch = matches[i];
		const before = input.slice(0, first.index);
		const after = input.slice(finalMatch.index + finalMatch[0].length);
		if (/[A-Za-z0-9_+]/.test(before.slice(-1)) || /^[A-Za-z0-9_]/.test(after)) continue;
		if (/[0-9]$/.test(before.replace(/[ .-]+$/, "")) || /^[0-9]/.test(after.replace(/^[ .-]+/, ""))) continue;
		if (card && !luhn(first[0])) continue;
		for (let n = start; n <= i; n++) {
			result += input.slice(last, matches[n].index) + "[num]";
			last = matches[n].index + matches[n][0].length;
		}
	}
	return last === 0 ? input : result + input.slice(last);
}

function luhn(input: string): boolean {
	const digits = input.replace(/[^0-9]/g, "");
	let sum = 0;
	for (let i = digits.length - 1, n = 0; i >= 0; i--, n++) {
		let digit = Number(digits[i]);
		if (n % 2 === 1) { digit *= 2; if (digit > 9) digit -= 9; }
		sum += digit;
	}
	return sum % 10 === 0;
}

function diagnosticValue(key: string, value: string): boolean {
	return (/(?:_ms$|^(?:timestamp|epoch|ts)$)/i.test(key) && /^[0-9]{10,16}$/.test(value))
		|| (/^(hash|huella|event|event_id)$/i.test(key) && /^[A-Fa-f0-9]{16,128}$/.test(value));
}

/** Filtra, en el sitio, todas las cadenas de un objeto o array, a cualquier profundidad. */
export function scrubDeep(value: unknown): void {
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			const v = value[i];
			if (typeof v === "string") value[i] = scrub(v);
			else scrubDeep(v);
		}
		return;
	}
	const obj = value as Record<string, unknown>;
	for (const k of Object.keys(obj)) {
		const v = obj[k];
		if (CLAVE_SECRETA.test(k)) obj[k] = "[redacted]";
		else if (typeof v === "string") { if (!diagnosticValue(k, v)) obj[k] = scrub(v); }
		else scrubDeep(v);
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
 * excepción, breadcrumbs (mensaje y datos), extra, etiquetas y la URL de la petición.
 *
 * No se tocan los campos estructurales (id del evento, release, tipo de excepción, trazas): no llevan
 * datos de nadie, y un id o una traza redactados dejan el evento inservible.
 */
export function scrubEvent<E extends EventoSentry>(event: E): E {
	if (typeof event.message === "string") event.message = scrub(event.message);
	if (event.logentry) {
		if (typeof event.logentry.message === "string") event.logentry.message = scrub(event.logentry.message);
		scrubDeep(event.logentry.params);
	}
	for (const exc of event.exception?.values ?? []) {
		if (typeof exc.value === "string") exc.value = scrub(exc.value);
	}
	for (const bc of event.breadcrumbs ?? []) {
		if (typeof bc.message === "string") bc.message = scrub(bc.message);
		scrubDeep(bc.data);
	}
	scrubDeep(event.extra);
	scrubDeep(event.tags);
	if (event.request) {
		if (typeof event.request.url === "string") event.request.url = scrub(event.request.url);
		const q = event.request.query_string;
		if (typeof q === "string") event.request.query_string = scrub(q);
		else scrubDeep(q);
	}
	return event;
}
