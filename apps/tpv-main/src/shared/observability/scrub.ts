// shared/observability/scrub.ts
//
// Depuración de contenido (scrubbing) de la Webview antes de enviar a Sentry (OBS-01). Espejo en TS
// del scrubber de Rust (`crates/tpv-telemetry/src/scrub.rs`): `sendDefaultPii=false` sólo cubre el
// contexto automático de Sentry (usuario/request), NO los mensajes de excepción/breadcrumb que
// compone la app. Aquí redactamos patrones sensibles (emails, IBAN, DNI/NIE, teléfonos, JWT,
// secretos `clave=valor`) para que no salgan en claro a un tercero.
//
// Es defensa en profundidad: el core Rust vuelve a depurar en su `before_send`, pero redactar ya en
// la Webview evita que el dato viaje siquiera por el puente JS→Rust.

type Rule = { re: RegExp; with: string };

// `g` para reemplazar todas las ocurrencias. El orden importa: primero lo específico.
const RULES: Rule[] = [
	// Cabecera de autorización: consume el valor entero, incluido el esquema (`Bearer <tok>`).
	{ re: /\b(authorization|auth)\b\s*[:=]\s*\S+(?:\s+\S+)?/gi, with: "$1=[redacted]" },
	// Esquemas de credencial sueltos (`Bearer <tok>` / `Basic <tok>`).
	{ re: /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=\-]{4,}/gi, with: "[redacted]" },
	// Secretos con forma `clave = valor` / `clave: valor` (se preserva la clave, se redacta el valor).
	{
		re: /\b(password|passwd|pwd|contrase(?:n|ñ)a|secret|token|api[_-]?key|apikey)\b\s*[:=]\s*\S+/gi,
		with: "$1=[redacted]",
	},
	// JWT (header.payload.signature en base64url).
	{ re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, with: "[jwt]" },
	// Emails.
	{ re: /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g, with: "[email]" },
	// IBAN.
	{ re: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g, with: "[iban]" },
	// Teléfonos / secuencias numéricas largas (prefijo internacional opcional).
	{ re: /\+?\d(?:[\s\-]?\d){8,14}/g, with: "[num]" },
	// DNI/NIE español.
	{ re: /\b[XYZ]?\d{7,8}[A-Za-z]\b/g, with: "[id]" },
];

/** Redacta patrones sensibles de una cadena. */
export function scrub(input: string): string {
	let out = input;
	for (const { re, with: repl } of RULES) {
		out = out.replace(re, repl);
	}
	return out;
}

/** Redacta en profundidad los valores de tipo cadena de un objeto/array (in place, tolerante). */
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
	for (const k of Object.keys(value as Record<string, unknown>)) {
		const obj = value as Record<string, unknown>;
		const v = obj[k];
		if (typeof v === "string") obj[k] = scrub(v);
		else scrubDeep(v);
	}
}
