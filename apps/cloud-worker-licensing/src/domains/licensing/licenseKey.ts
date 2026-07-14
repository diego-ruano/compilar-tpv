// src/domains/licensing/licenseKey.ts
//
// La clave de licencia: generación, forma canónica y hash.
//
// Formato: TPV-XXXXX-XXXXX-XXXXX-XXXXX (20 símbolos = 100 bits de entropía).
// Alfabeto base32 **Crockford**: sin I, L, O ni U, para que nadie confunda un 1 con una I
// ni un 0 con una O al dictarla por teléfono o teclearla desde un email.
//
// Regla de oro: la clave en claro solo existe en tres sitios — el email del cliente, el
// formulario de activación y este módulo. En la BD viven su `sha256` (indexado, único) y
// una copia cifrada con AES-GCM (para poder reenviársela a alguien que la pierda).

import { sha256Hex } from "../../server/crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32
const GROUPS = 4;
const GROUP_LEN = 5;
const PREFIX = "TPV";

/** Genera una clave nueva con CSPRNG. Rechazo por módulo evitado: 256 % 32 === 0. */
export function generateLicenseKey(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(GROUPS * GROUP_LEN));
	const symbols = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]);

	const groups: string[] = [];
	for (let g = 0; g < GROUPS; g++) {
		groups.push(symbols.slice(g * GROUP_LEN, (g + 1) * GROUP_LEN).join(""));
	}
	return `${PREFIX}-${groups.join("-")}`;
}

/**
 * Forma canónica de lo que teclea el usuario. Tolera minúsculas, espacios, guiones de más
 * o de menos, el prefijo ausente y las confusiones clásicas de Crockford (I/L→1, O→0).
 * Devuelve `null` si no es una clave con nuestra forma.
 *
 * El hash SIEMPRE se calcula sobre esta forma canónica: si no, la misma clave escrita en
 * minúsculas no encontraría su fila.
 */
export function normalizeLicenseKey(input: string): string | null {
	const raw = String(input || "")
		.toUpperCase()
		.replace(/[^0-9A-Z]/g, "") // fuera guiones, espacios y demás adornos
		.replace(/^TPV/, "")
		.replace(/[IL]/g, "1")
		.replace(/O/g, "0");

	if (raw.length !== GROUPS * GROUP_LEN) return null;
	for (const ch of raw) {
		if (!ALPHABET.includes(ch)) return null;
	}

	const groups: string[] = [];
	for (let g = 0; g < GROUPS; g++) {
		groups.push(raw.slice(g * GROUP_LEN, (g + 1) * GROUP_LEN));
	}
	return `${PREFIX}-${groups.join("-")}`;
}

/** sha256 de la forma canónica. Lanza si la clave no tiene forma válida. */
export async function licenseKeyHash(input: string): Promise<string> {
	const canonical = normalizeLicenseKey(input);
	if (!canonical) throw new Error("invalid_license_key_format");
	return sha256Hex(canonical);
}

/** Versión mostrable en la UI: "TPV-…-WX7Q". No es sensible (no permite reconstruirla). */
export function licenseKeyShort(canonicalKey: string): string {
	return `${PREFIX}-…-${canonicalKey.slice(-4)}`;
}
