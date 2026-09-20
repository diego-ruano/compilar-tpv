// src/shared/lib/dinero.ts
//
// El dinero de la interfaz: **céntimos enteros**, igual que en la base, en Rust y en el worker
// (ARQ-01). Este fichero es el tercer espejo de `crates/tpv-domain/src/dinero.rs`; lo que mantiene
// a los tres iguales es `crates/tpv-domain/src/dinero_casos.json`, la tabla de casos que leen los
// tests de los tres. Al tocar la aritmética del dinero no se escriben tres funciones: se añade un
// caso ahí y los otros dos lados se ponen rojos hasta igualarse.
//
// ## Por qué los céntimos llegan hasta aquí
//
// Convertir a euros en la frontera reintroduciría el flotante justo donde el usuario lo ve, y
// dejaría a esta capa sumando importes en coma flotante — que es como el total del PDF con el que
// se cuadra la caja acababa arrastrando un céntimo. Los céntimos llegan a la pantalla y se
// convierten **una sola vez**, al formatear.
//
// ## La marca no caza los errores de unidad por sí sola
//
// Un `Dinero` SIGUE SIENDO un `number`, así que pasárselo a un formateador que espere euros
// compila y pinta «4750 €». Lo que cierra ese hueco es que el formateador de abajo recibe
// `Dinero`: mientras todo el dinero pase por él, la unidad no se puede equivocar. La marca cubre
// la otra mitad —que no entre un número crudo donde va un importe— y las dos juntas son lo que
// hace que no quede ningún sitio a medias.

import type { Dinero } from "@tpv/contracts";

/** Ni un céntimo. */
export const CERO = 0 as Dinero;

/** Marca un entero de céntimos como importe. Es la única puerta de entrada. */
export function deCentimos(centimos: number): Dinero {
	return (Number.isFinite(centimos) ? Math.trunc(centimos) : 0) as Dinero;
}

/**
 * Redondea al céntimo **alejando la mitad del cero**, como `f64::round` de Rust.
 *
 * `Math.round` no vale: lleva la mitad hacia +∞ (−12,5 → −12) y Rust la aleja del cero (−13). Esa
 * diferencia exacta separó a la vista previa del ticket del papel que salía por la impresora.
 */
export function redondear(centimos: number): Dinero {
	if (!Number.isFinite(centimos)) return CERO;
	const abs = Math.round(Math.abs(centimos));
	return ((centimos < 0 ? -abs : abs) || 0) as Dinero;
}

/** Euros → `Dinero`. Para lo que una persona teclea, y para lo que sigue siendo fraccionario. */
export function deEuros(euros: number): Dinero {
	return redondear(euros * 100);
}

/** Suma de importes. Exacta: son enteros. */
export function sumar(...importes: Dinero[]): Dinero {
	let acc = 0;
	for (const d of importes) acc += d;
	return acc as Dinero;
}

/** Resta. */
export function restar(a: Dinero, b: Dinero): Dinero {
	return (a - b) as Dinero;
}

/** Multiplica por un número entero de unidades. */
export function por(d: Dinero, unidades: number): Dinero {
	return redondear(d * unidades);
}

/** Multiplica por un factor fraccionario (un tipo de IVA, un peso). */
export function escalar(d: Dinero, factor: number): Dinero {
	if (!Number.isFinite(factor)) return CERO;
	return redondear(d * factor);
}

/**
 * Divide por un divisor fraccionario. Gemelo de `Dinero::entre` en Rust.
 *
 * **No es `escalar(d, 1/divisor)`**: multiplicar por el recíproco pierde un bit y cambia el
 * céntimo (la base de 0,91 € al 4 % sale 87 por ese camino y 88 dividiendo).
 */
export function entre(d: Dinero, divisor: number): Dinero {
	if (!Number.isFinite(divisor) || divisor === 0) return CERO;
	return redondear(d / divisor);
}

/** ¿Es exactamente cero? Con enteros, la pregunta por fin significa lo que parece. */
export function esCero(d: Dinero): boolean {
	return d === 0;
}

/** ¿Falta dinero? */
export function esNegativo(d: Dinero): boolean {
	return d < 0;
}

/** El valor absoluto. */
export function abs(d: Dinero): Dinero {
	return Math.abs(d) as Dinero;
}

/**
 * El importe como lo escribe la AEAT: punto decimal, siempre dos decimales, sin `-0.00`.
 * Gemelo de `Dinero::texto_fiscal`. No es lo que se enseña en pantalla.
 */
export function textoFiscal(d: Dinero): string {
	const signo = d < 0 ? "-" : "";
	const a = Math.abs(d);
	return `${signo}${Math.trunc(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}

/**
 * **El formateador de la interfaz.** Todo importe que se pinta pasa por aquí.
 *
 * Existía en siete copias —tres llamadas `eur`, tres `formatEur` y una más— y no eran iguales:
 * cuatro protegían contra un valor no finito y tres no, así que el mismo importe corrupto salía
 * como `0,00 €` en Estadísticas y como `NaN €` en las tres pantallas de venta. Ahora es una.
 *
 * Usa `Intl` a propósito: en pantalla el separador de miles ayuda a leer. El **papel** es otra
 * cosa y tiene su propio formateador (`shared/ticket/ticketMath.ts`), que no lleva separador
 * porque en una columna de 32 caracteres un punto de millar se confunde con el decimal.
 */
const FORMATO = new Intl.NumberFormat("es-ES", {
	style: "currency",
	currency: "EUR",
	minimumFractionDigits: 2,
	maximumFractionDigits: 2,
});

export function eur(d: Dinero): string {
	// `|| 0` se lleva por delante el -0, que `Intl` pinta como «-0,00 €».
	return FORMATO.format((Number.isFinite(d) ? d / 100 : 0) || 0);
}

/**
 * Lo que una persona teclea en un campo de precio → `Dinero`.
 *
 * Acepta la coma y el punto (el teclado numérico de un TPV da coma) y descarta lo que no sea un
 * número. Devuelve `null` si no hay nada que leer, para que el llamante decida si eso es un cero
 * o un campo sin rellenar — que no son lo mismo en un precio.
 */
export function deTexto(texto: string): Dinero | null {
	const t = String(texto ?? "").trim().replace(",", ".");
	if (t === "") return null;
	const n = Number(t);
	return Number.isFinite(n) ? deEuros(n) : null;
}

/** Un importe en el cuadro de texto que lo edita: euros con coma, sin símbolo. */
export function aTexto(d: Dinero): string {
	return textoFiscal(d).replace(".", ",");
}
