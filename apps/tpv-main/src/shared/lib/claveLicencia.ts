// src/shared/lib/claveLicencia.ts
//
// LIC-INC-01 · La forma de una clave de licencia, para avisar en la pantalla de que está mal escrita
// antes de pulsar. Quien decide es el backend (`clave_canonica` en `tpv-domain/src/licensing.rs`),
// que la rechaza sin ir a la red con el mismo texto; la nube aplica la misma regla
// (`normalizeLicenseKey`). Las tres recorren `crates/tpv-domain/src/clave_licencia_casos.json`
// (`test/claveLicencia.test.ts`): si una cambia de criterio, se pone rojo su test.

/** Lo que se le dice a quien la escribe mal: el mismo texto que la Main y la nube. */
export const MSG_CLAVE_MAL_FORMADA =
	"La clave de licencia no tiene el formato correcto: son 20 letras y números, como TPV-XXXXX-XXXXX-XXXXX-XXXXX. Revísala.";

/** El ejemplo del campo: el formato de verdad. */
export const EJEMPLO_CLAVE = "TPV-XXXXX-XXXXX-XXXXX-XXXXX";

const ALFABETO = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // base32 de Crockford: sin I, L, O ni U
const GRUPOS = 4;
const POR_GRUPO = 5;

/**
 * La forma canónica (`TPV-XXXXX-XXXXX-XXXXX-XXXXX`) o `null` si lo escrito no es una clave. Tolera
 * minúsculas, espacios y guiones de más o de menos, el prefijo ausente y las confusiones de
 * Crockford (O → 0, I y L → 1).
 */
export function claveCanonica(entrada: string): string | null {
	const simbolos = entrada
		.toUpperCase()
		.replace(/[^0-9A-Z]/g, "")
		.replace(/^TPV/, "")
		.replace(/[IL]/g, "1")
		.replace(/O/g, "0");
	if (simbolos.length !== GRUPOS * POR_GRUPO || [...simbolos].some((c) => !ALFABETO.includes(c))) return null;
	const grupos: string[] = [];
	for (let g = 0; g < GRUPOS; g++) grupos.push(simbolos.slice(g * POR_GRUPO, (g + 1) * POR_GRUPO));
	return `TPV-${grupos.join("-")}`;
}

/**
 * El aviso que va junto al campo, o `null`. Mientras se escribe no se avisa (una clave a medias no
 * es una clave todavía): sólo cuando se ha dejado el campo (`terminada`) con algo que no lo es.
 */
export function avisoDeClave(entrada: string, terminada: boolean): string | null {
	if (!terminada || entrada.trim() === "") return null;
	return claveCanonica(entrada) === null ? MSG_CLAVE_MAL_FORMADA : null;
}
