// src/lib/fechas.ts
//
// Fechas de calendario que llegan como texto (RI-78). Espejo de `tpv-domain/src/fechas.rs`: un
// único criterio para todos los dominios, con sus casos en `validacion_casos.json`.
//
// Antes cada schema traía su propia expresión regular, que sólo miraba la forma: un 31 de febrero
// pasaba, y de ahí en adelante cada pieza hacía una cosa distinta con él (SQLite y `Date.UTC` lo
// convierten en 3 de marzo; el calendario de la pantalla no lo enseña en ningún día).

import * as z from "zod";
import { recortar } from "./texto";

const FORMA_YMD = /^\d{4}-\d{2}-\d{2}$/;

/** ¿Es `s` **exactamente** `YYYY-MM-DD` y existe en el calendario? */
export function esFechaYmd(s: string): boolean {
	if (!FORMA_YMD.test(s)) return false;
	// `Date.parse` admite un día 31 en cualquier mes y lo desborda al siguiente: se compara la
	// fecha que sale con la que entró.
	const t = Date.parse(`${s}T00:00:00Z`);
	return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

const FORMA_HORA = /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;

/**
 * El día de un instante: `YYYY-MM-DD HH:MM:SS` (la hora local canónica del esquema) o una fecha
 * sola. `null` si `s` no es ninguna de las dos cosas **entero**. Espejo de `fecha_de_instante`.
 */
export function diaDeInstante(s: string): string | null {
	if (esFechaYmd(s)) return s;
	if (s.length !== 19 || s[10] !== " ") return null;
	const dia = s.slice(0, 10);
	return esFechaYmd(dia) && FORMA_HORA.test(s.slice(11)) ? dia : null;
}

/**
 * Un día `YYYY-MM-DD` a partir de lo que llegue: recorta los espacios y descarta lo que siga a los
 * diez primeros caracteres (una hora). `null` si eso no es una fecha real. Espejo de
 * `normalize_dia_ymd` en la Main.
 */
export function normalizarDia(raw: unknown): string | null {
	const candidato = recortar(String(raw ?? "")).slice(0, 10);
	return esFechaYmd(candidato) ? candidato : null;
}

/**
 * Un campo de día para un schema. El fallo sale como un `issue` de zod: una excepción dentro de
 * un `transform` no la recoge el validador y la petición acababa en un 500.
 */
export function zDia(mensaje: string) {
	return z.unknown().transform((v, ctx) => {
		const dia = normalizarDia(v);
		if (dia === null) {
			ctx.addIssue({ code: "custom", message: mensaje });
			return z.NEVER;
		}
		return dia;
	});
}
