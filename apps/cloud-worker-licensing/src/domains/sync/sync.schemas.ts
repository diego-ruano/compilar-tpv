// src/domains/sync/sync.schemas.ts
//
// Los cuerpos permisivos de la recuperación, el contraste y la observabilidad (ARQ-06). Son schemas
// TOTALES a propósito: aquí un campo extraño cae a su default o se descarta, nunca bloquea vender.
// `cuerpoTolerante` conserva además el comportamiento histórico del JSON ausente o mal formado.

import * as z from "zod";

import { MAX_CUBOS } from "./resumenCubos";

/**
 * Tope de filas por página del histórico. Lo impone el servidor: el cliente pide, no manda. Lo que
 * acota de verdad el rato que una página ocupa el hilo del TenantHub es su techo en bytes
 * (`HISTORICO_MAX_BYTES`, `volcado.ts`): unas 10.000 filas de las normales caben en él. Una Main
 * que lo pide sin `limite` (o una anterior, que pide 1.000) recibe lo de siempre.
 */
export const HISTORICO_MAX_FILAS = 10_000;
const HISTORICO_FILAS_DEFECTO = 1_000;

/**
 * Claves por página del contraste (`/v1/sync/verificar/claves`): las que se dan sin pedir, y el
 * tope. Lo impone el servidor; la página tiene además su techo en bytes (`verificar.ts`).
 */
export const CLAVES_POR_PAGINA = 10_000;
export const CLAVES_POR_PAGINA_MAX = 20_000;

/** Claves por petición de `/v1/sync/verificar/por-clave`: lo que se enlaza en una sentencia. */
export const CLAVES_POR_PETICION_MAX = 1_000;

function objeto(valor: unknown): Record<string, any> {
	return valor !== null && typeof valor === "object" ? (valor as Record<string, any>) : {};
}

function numero(valor: unknown, defecto: number): number {
	return Number(valor ?? defecto) || defecto;
}

export const changesSchema = z.unknown().transform((entrada) => {
	const body = objeto(entrada);
	return {
		since: Math.max(0, numero(body.since, 0)),
		limit: Math.min(Math.max(1, numero(body.limit, 500)), 1_000),
	};
});

export const historicoSchema = z.unknown().transform((entrada) => {
	const body = objeto(entrada);
	return {
		tabla: String(body.tabla ?? ""),
		cursor: Math.max(0, numero(body.cursor, 0)),
		limite: Math.min(
			Math.max(1, numero(body.limite, HISTORICO_FILAS_DEFECTO)),
			HISTORICO_MAX_FILAS,
		),
	};
});


/* ===== El contraste por resúmenes (`verificar.ts`) ===== */

/** El checkpoint de la Main que pide el resumen. Sin él, o con algo que no es un `Seq`, `null`. */
export const verificarResumenSchema = z.unknown().transform((entrada) => {
	const { checkpoint } = objeto(entrada);
	return {
		checkpoint: typeof checkpoint === "number" && Number.isSafeInteger(checkpoint) && checkpoint >= 0 ? checkpoint : null,
	};
});

/** Los cubos de una tabla cuyas filas se piden. Qué tabla y cuántos cubos lo valida la ruta. */
export const verificarFilasSchema = z.unknown().transform((entrada) => {
	const body = objeto(entrada);
	const pedir: unknown[] = Array.isArray(body.pedir) ? body.pedir.slice(0, MAX_CUBOS) : [];
	return {
		tabla: typeof body.tabla === "string" ? body.tabla : "",
		// Se enlaza como parámetro de la ventana, no se interpola: basta con que sea un texto corto.
		desde: typeof body.desde === "string" ? body.desde.slice(0, 40) : "",
		cubos: typeof body.cubos === "number" ? body.cubos : Number.NaN,
		pedir,
		cursor: Math.max(0, Math.floor(numero(body.cursor, 0))),
	};
});

/**
 * Unas filas por su clave. Lo que pasa del tope se descarta (la Main pide de menos en menos); que
 * cada clave lo sea de esa tabla lo comprueba la ruta.
 */
export const verificarPorClaveSchema = z.unknown().transform((entrada) => {
	const body = objeto(entrada);
	return {
		tabla: typeof body.tabla === "string" ? body.tabla : "",
		claves: (Array.isArray(body.claves) ? body.claves.slice(0, CLAVES_POR_PETICION_MAX) : []) as unknown[][],
	};
});

/** Una página de las claves de una tabla. El cursor es la última clave de la página anterior. */
export const verificarClavesPorPaginasSchema = z.unknown().transform((entrada) => {
	const body = objeto(entrada);
	return {
		tabla: typeof body.tabla === "string" ? body.tabla : "",
		cursor: Array.isArray(body.cursor) ? (body.cursor.slice(0, 8) as unknown[]) : null,
		limite: Math.min(Math.max(1, Math.floor(numero(body.limite, CLAVES_POR_PAGINA))), CLAVES_POR_PAGINA_MAX),
	};
});

export const saludSyncSchema = z.unknown().transform((entrada) => {
	const body = objeto(entrada);
	const descuadres: any[] = Array.isArray(body.descuadres) ? body.descuadres.slice(0, 50) : [];
	return {
		descuadres: descuadres.map((d) => ({
			tabla: String(d?.tabla ?? "").slice(0, 64),
			faltan: Number(d?.faltan ?? 0),
			sobran: Number(d?.sobran ?? 0),
			distintas: Number(d?.distintas ?? 0),
		})),
		apartadas: Number(body.apartadas ?? 0),
		reparadas: Number(body.reparadas ?? 0),
		borradas: Number(body.borradas ?? 0) || 0,
		// Hay algo que la pasada vio y no tocó (o no llegó a mirar entero): no es lo mismo que
		// «todo cuadra».
		aplazado: body.aplazado === true,
		// Filas que se bajaron para compararlas una a una: las de los cubos que no cuadraban.
		filas_examinadas: Number(body.filas_examinadas ?? 0) || 0,
		// Tablas que no se pudieron comparar, por su nombre: sólo identificadores, y pocos.
		tablas_sin_comparar: (Array.isArray(body.tablas_sin_comparar) ? body.tablas_sin_comparar : [])
			.filter((t: unknown): t is string => typeof t === "string" && /^[A-Za-z0-9_]{1,64}$/.test(t))
			.slice(0, 50),
		ventana_omitida: Boolean(body.ventana_omitida),
		// PROD-06: el interruptor `reparacion_nube` estaba apagado y no se reparó nada. Sin esto,
		// un «0 reparadas» se leería igual que «no había nada que reparar».
		reparacion_apagada: Boolean(body.reparacion_apagada),
	};
});
