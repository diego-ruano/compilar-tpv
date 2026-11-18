// src/features/configuracion/borrador.ts
//
// CFG-INC-01: un formulario de ajustes que otro equipo cambia mientras se edita.
//
// Antes el borrador se copiaba del store una vez, «sin guardar» se comparaba con el store vivo y al
// guardar se mandaban todos los campos: si la Handy cambiaba el teléfono mientras en la Main se
// escribía la dirección, guardar la dirección devolvía el teléfono a lo de antes, y el cambio de la
// Handy salía además como «Cambios sin guardar» en la Main. Ahora, como en el formulario de una
// reserva (`features/reservas/edicion.ts`):
// - el borrador recuerda su `base`, lo que había guardado cuando se tomó;
// - «sin guardar» es el borrador frente a su base, no frente a lo que haya ahora;
// - cuando llega lo de otro equipo, los campos que no se han tocado toman el valor nuevo y la base
//   se renueva; los tocados se quedan como los dejó quien edita, y si ese mismo campo cambió fuera
//   se avisa junto a él (`choques`);
// - al guardar se manda sólo lo que difiere de la base (`cambiosDe`): el backend admite un PATCH
//   parcial, y lo que no se ha tocado aquí no se vuelve a escribir.

/** Lo que otro equipo ha puesto en un campo que aquí también se ha cambiado, por campo. */
export type Choques<T> = Partial<T>;

/** ¿Es el mismo valor? `Object.is` salvo que 10 y 10.0 son el mismo número. */
function igual(a: unknown, b: unknown): boolean {
	return Object.is(a, b) || (typeof a === "number" && typeof b === "number" && a === b);
}

/** Los campos en los que `a` y `b` no coinciden. */
export function camposDistintos<T extends object>(a: T, b: T, campos: readonly (keyof T)[]): (keyof T)[] {
	return campos.filter((k) => !igual(a[k], b[k]));
}

/** Lo que hay que mandar al guardar: sólo los campos del borrador que difieren de su base. */
export function cambiosDe<T extends object>(borrador: T, base: T, campos: readonly (keyof T)[]): Partial<T> {
	const out: Partial<T> = {};
	for (const k of camposDistintos(borrador, base, campos)) out[k] = borrador[k];
	return out;
}

/**
 * El borrador tras llegar `fresco`, cuando se había tomado sobre `base`.
 *
 * Un campo que no se ha tocado (`tocado(k)` falso; por defecto, igual que en la base) toma el valor
 * de `fresco`. Uno tocado se queda; si además cambió fuera, y no a lo mismo que se ha escrito aquí,
 * es un choque: lo nuevo de fuera se devuelve para avisarlo. Los choques de antes se conservan
 * mientras el campo siga tocado.
 */
export function rebasarBorrador<T extends object>(
	borrador: T,
	base: T,
	fresco: T,
	campos: readonly (keyof T)[],
	choquesAntes: Choques<T> = {},
	tocado: (k: keyof T) => boolean = (k) => !igual(borrador[k], base[k]),
): { borrador: T; choques: Choques<T> } {
	const out = { ...borrador };
	const choques: Choques<T> = {};
	for (const k of campos) {
		if (!tocado(k)) {
			out[k] = fresco[k];
			continue;
		}
		if (!igual(fresco[k], base[k]) && !igual(fresco[k], borrador[k])) {
			choques[k] = fresco[k];
		} else if (k in choquesAntes && !igual(fresco[k], borrador[k])) {
			choques[k] = choquesAntes[k];
		}
	}
	return { borrador: out, choques };
}
