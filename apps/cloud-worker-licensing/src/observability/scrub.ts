// src/observability/scrub.ts
//
// Filtro de datos personales (scrubbing) del worker antes de que un error salga hacia Sentry
// (OBS-01). `sendDefaultPii: false` sólo quita el contexto automático (cabeceras, cookies, IP): no
// toca el mensaje de una excepción, los breadcrumbs ni los datos extra, y un error de una ruta de
// licencias o de trabajadores puede llevar un correo, un DNI o un IBAN dentro. Un registro de errores
// no necesita ninguno, así que lo que tenga forma de dato personal se sustituye por un marcador.
//
// Lo que se reenvía a Axiom no pasa por aquí porque no lo necesita: los lotes de los equipos llegan
// ya filtrados desde el core de Rust, y los eventos propios del worker sólo llevan identificadores y
// agregados.
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

// El orden importa: primero lo específico, para que una regla genérica no se quede media coincidencia.
const REGLAS: Regla[] = [
	// Cabecera de autorización: consume el valor entero, incluido el esquema (`Bearer <tok>`).
	{ re: /\b(authorization|auth)\b\s*[:=]\s*\S+(?:\s+\S+)?/gi, con: "$1=[redacted]" },
	// Esquemas de credencial sueltos (`Bearer <tok>` / `Basic <tok>`).
	{ re: /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=\-]{4,}/gi, con: "[redacted]" },
	// Secretos con forma `clave = valor` / `clave: valor`. Se conserva la clave, que dice «qué».
	{
		re: /\b(password|passwd|pwd|contrase(?:n|ñ)a|secret|token|api[_-]?key|apikey|pin|otp)\b\s*[:=]\s*\S+/gi,
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
	// Teléfonos, tarjetas y cualquier otra secuencia de 9 a 19 cifras (con espacios, puntos o guiones).
	{ re: /\+?[0-9](?:[ .\-]?[0-9]){8,18}/g, con: "[num]" },
];

/** Sustituye por un marcador lo que tenga forma de dato personal o de secreto. */
export function scrub(input: string): string {
	let out = input;
	for (const { re, con } of REGLAS) {
		out = out.replace(re, con);
	}
	return out;
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
		if (typeof v === "string") obj[k] = scrub(v);
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
