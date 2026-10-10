// src/lib/dinero.ts
//
// El dinero del worker: **céntimos enteros**, igual que en la base y en Rust (ARQ-01).
//
// Este fichero es el ESPEJO de `crates/tpv-domain/src/dinero.rs`. No pueden compartir código —uno
// corre en un isolate de Workers y el otro en la Main—, así que lo que los mantiene iguales son
// los casos de `crates/tpv-domain/src/dinero_casos.json`, que leen los tests de los dos lados. Una
// regla nueva lleva su caso ahí, o el otro lado no se entera.
//
// ## La trampa que este fichero existe para cerrar
//
// `Math.round` de JavaScript lleva la mitad hacia **+infinito** (`Math.round(-2.5) === -2`) y el
// `f64::round` de Rust la **aleja del cero** (`-3`). Mientras el dinero fue un flotante, esa
// diferencia ya separó a la vista previa del ticket del papel que salía por la impresora. Aquí se
// corrige de una vez: todo redondeo de dinero pasa por `redondear`.
//
// Y una división NO es una multiplicación por el recíproco: la base de 0,91 € al 4 % sale 87
// multiplicando por `1/1.04` y 88 dividiendo por `1.04`. Por eso `entre` divide.

import * as z from "zod";

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
 * `Math.round` no vale: lleva la mitad hacia +infinito y discreparía con la Main en los negativos.
 */
export function redondear(centimos: number): Dinero {
	if (!Number.isFinite(centimos)) return CERO;
	const abs = Math.round(Math.abs(centimos));
	return ((centimos < 0 ? -abs : abs) || 0) as Dinero;
}

/** Lo que sale de la base de datos: un `INTEGER` de céntimos, o cero si no hay fila. */
export function deLaBase(v: unknown): Dinero {
	const n = typeof v === "bigint" ? Number(v) : Number(v ?? 0);
	return redondear(Number.isFinite(n) ? n : 0);
}

/** Suma de importes. Exacta: son enteros. */
export function sumar(...importes: Dinero[]): Dinero {
	let acc = 0;
	for (const d of importes) acc += d;
	return acc as Dinero;
}

/** Multiplica por un número entero de unidades. */
export function por(d: Dinero, unidades: number): Dinero {
	return redondear(d * unidades);
}

/** Multiplica por un factor fraccionario (un tipo de IVA, un peso del prorrateo). */
export function escalar(d: Dinero, factor: number): Dinero {
	if (!Number.isFinite(factor)) return CERO;
	return redondear(d * factor);
}

/**
 * Divide por un divisor fraccionario. Gemelo de `Dinero::entre` en Rust.
 *
 * Es lo que necesitan los promedios (el ticket medio) y la base del IVA. **No es
 * `escalar(d, 1/divisor)`**: multiplicar por el recíproco pierde un bit y cambia el céntimo.
 */
export function entre(d: Dinero, divisor: number): Dinero {
	if (!Number.isFinite(divisor) || divisor === 0) return CERO;
	return redondear(d / divisor);
}

/**
 * El importe como lo escribe la AEAT: punto decimal, siempre dos decimales, sin `-0.00`.
 * Gemelo de `Dinero::texto_fiscal`.
 */
export function textoFiscal(d: Dinero): string {
	const signo = d < 0 ? "-" : "";
	const abs = Math.abs(d);
	return `${signo}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** El importe en euros para un texto que lee una persona (`3,00 €`). */
export function enEuros(d: Dinero): string {
	return `${textoFiscal(d).replace(".", ",")} €`;
}

/**
 * El validador de zod para un importe que llega por la API.
 *
 * Viene en **céntimos enteros** (ARQ-01), así que se exige entero: un `12.5` en el cuerpo de una
 * petición ya no es «doce euros con medio», es un cliente que habla en la unidad equivocada y lo
 * correcto es rechazarlo en la puerta, no redondearlo por su cuenta.
 *
 * El `.transform` sólo pone la marca: el valor no cambia. Es lo que hace que el resto del worker
 * no pueda confundir un importe con un número cualquiera.
 */
export const zDinero = z
	.number()
	.int("el importe va en céntimos enteros")
	.finite()
	.transform((v) => v as Dinero);

/** Como `zDinero`, pero rechazando además los negativos. */
export const zDineroNoNegativo = zDinero.refine((v) => v >= 0, "el importe no puede ser negativo");

/** Un importe opcional de la API (`null`/ausente = no informado). */
export const zDineroOpcional = zDinero.nullish();
