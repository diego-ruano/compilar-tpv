// src/lib/fiscal.ts
//
// FISCAL-02 · Los datos para facturarle a un cliente (`Clientes.NIF`, `Razon_Social`,
// `Direccion_Fiscal`), normalizados como en la Main: el NIF como `normalizar_nif` y `nif_valido`, y
// la razón social y la dirección como `sanear_texto` (`crates/tpv-domain/src/verifactu.rs`), que es
// lo que hace `validar_destinatario` con el destinatario de una factura. Lo que se guarda en la ficha
// desde la Handy tiene que ser lo mismo que guardaría la Main, y lo mismo que saldría en el papel.
//
// Lo fijan dos tablas que leen los dos lados: `nif_casos.json` (qué NIF vale) y los casos `cliente`
// de `validacion_casos.json` (cómo queda cada campo y qué se dice al rechazar).

import { recortar } from "./texto";

/** El tope de la razón social: el del nombre del destinatario en el registro de facturación. */
export const MAX_RAZON_SOCIAL = 120;
/** El tope del domicilio del destinatario, que sólo va al papel. */
export const MAX_DIRECCION_FISCAL = 250;
/** Un NIF que no pasa el control. El mismo texto que `MSG_NIF_NO_VALIDO` en la Main. */
export const MSG_NIF_NO_VALIDO = "El NIF no es válido: revisa las cifras y la letra.";

/** Letras de control de un NIF de persona física, por el resto entre 23. */
const LETRAS_NIF = "TRWAGMYFPDXBNJZSQVHLCKE";
/** Iniciales de un NIF de persona jurídica o entidad: arts. 3, 4 y 5.2 de la Orden EHA/451/2008. */
const INICIALES_CIF = "ABCDEFGHJNPQRSUVW";

/**
 * Como `normalizar_nif`: recortado como `str::trim`, las letras ASCII en mayúsculas (y sólo ésas) y
 * sin guiones ni espacios normales en medio.
 */
export function normalizarNif(nif: string): string {
	return recortar(nif)
		.replace(/[a-z]/g, (c) => c.toUpperCase())
		.replace(/[- ]/g, "");
}

/** Como `nif_valido`: NIF, NIE, NIF K/L/M (sólo la forma) y CIF, con su control. */
export function nifValido(nif: string): boolean {
	const s = normalizarNif(nif);
	if (s.length !== 9 || [...s].some((c) => c.charCodeAt(0) > 0x7f)) return false;

	// Persona física: 8 dígitos + letra.
	if (/^\d{8}[A-Za-z]$/.test(s)) return s[8] === LETRAS_NIF[Number(s.slice(0, 8)) % 23];

	// NIE: X/Y/Z + 7 dígitos + letra (la inicial vale 0/1/2).
	if (/^[XYZ]\d{7}[A-Za-z]$/.test(s)) {
		const pref = { X: "0", Y: "1", Z: "2" }[s[0] as "X" | "Y" | "Z"];
		return s[8] === LETRAS_NIF[Number(pref + s.slice(1, 8)) % 23];
	}

	// NIF K, L y M: sólo la forma (art. 20 del RD 1065/2007 no publica el control).
	if (/^[KLM]/.test(s)) return /^[KLM][0-9A-Za-z]{7}[A-Za-z]$/.test(s);

	// CIF: letra + 7 dígitos + control (dígito o letra según la inicial).
	if (INICIALES_CIF.includes(s[0]) && /^.\d{7}/.test(s)) {
		let par = 0;
		let impar = 0;
		for (let i = 0; i < 7; i++) {
			const d = Number(s[1 + i]);
			if (i % 2 === 0) {
				const doble = d * 2;
				impar += Math.floor(doble / 10) + (doble % 10);
			} else {
				par += d;
			}
		}
		const control = (10 - ((par + impar) % 10)) % 10;
		const letra = "JABCDEFGHI"[control];
		if ("PQRSNW".includes(s[0])) return s[8] === letra;
		if ("ABEH".includes(s[0])) return s[8] === String(control);
		return s[8] === String(control) || s[8] === letra;
	}
	return false;
}

/** Lo que `sanear_texto` cambia por un espacio: los signos que la AEAT no admite y los de control. */
function seCambiaPorEspacio(c: string): boolean {
	return c === "<" || c === ">" || c === '"' || c === "'" || c === "=" || c.codePointAt(0)! < 0x20;
}

/**
 * Como `sanear_texto`: los signos que no caben en el registro y los caracteres de control pasan a
 * espacio, los espacios seguidos se quedan en uno, se corta a `max` caracteres (puntos de código,
 * como `chars().take()`) y se recorta como `str::trim`.
 */
export function sanearTexto(valor: string, max: number): string {
	let out = "";
	let espacio = false;
	let n = 0;
	for (const original of valor) {
		const c = seCambiaPorEspacio(original) ? " " : original;
		if (c === " ") {
			espacio = true;
			continue;
		}
		if (espacio && out.length > 0) {
			if (n >= max) break;
			out += " ";
			n++;
		}
		espacio = false;
		if (n >= max) break;
		out += c;
		n++;
	}
	return recortar(out);
}
