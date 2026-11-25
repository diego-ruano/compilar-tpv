// src/durableObjects/instantes.ts
//
// Devolver la base de un objeto a un instante: lo que comparten la base de cada negocio
// (`tenantHub.instante.ts`) y la central (`baseCentral.instante.ts`).
//
// El SQLite de un Durable Object guarda 30 días de historia y Cloudflare lo puede devolver a
// cualquier punto de ellos (point-in-time recovery,
// https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api):
//
// - `getBookmarkForTime(instante)` da el marcador de ese instante, y `getCurrentBookmark()` el de ahora.
// - `onNextSessionRestoreBookmark(marcador)` deja la vuelta preparada para el siguiente arranque del
//   objeto y devuelve un marcador con el que se deshace: el de justo antes de volver, es decir, lo que
//   haya en el objeto cuando se reinicie, también lo que se escriba después de pedirlo.
// - `ctx.abort()` reinicia el objeto, y al arrancar vuelve. Se lleva **todo** lo guardado: el SQL y
//   lo que va por `put()`. La alarma, la documentación no lo dice: se vuelve a armar al primer acceso.
//
// No está en local ni en los tests («not supported in local development»: workerd lanza «This
// Durable Object's storage back-end does not implement point-in-time recovery»). Por eso va detrás
// de `Instantes`, que un test sustituye por un doble.

/** Lo que se le pide a la plataforma. Un test lo sustituye: en local no existe. */
export type Instantes = {
	marcadorActual(): Promise<string>;
	marcadorDe(instanteMs: number): Promise<string>;
	/** Deja la vuelta preparada para el siguiente arranque. Devuelve el marcador con el que se deshace. */
	restaurarAlReiniciar(marcador: string): Promise<string>;
	/** Reinicia el objeto, que vuelve al arrancar. No vuelve: lanza en quien lo llama por RPC. */
	reiniciar(motivo: string): void;
};

export function instantesDe(state: DurableObjectState): Instantes {
	return {
		marcadorActual: () => state.storage.getCurrentBookmark(),
		marcadorDe: (instanteMs) => state.storage.getBookmarkForTime(instanteMs),
		restaurarAlReiniciar: (marcador) => state.storage.onNextSessionRestoreBookmark(marcador),
		reiniciar: (motivo) => state.abort(motivo),
	};
}

/** Cuánto atrás deja volver Cloudflare. */
const VENTANA_DE_VUELTA_MS = 30 * 24 * 60 * 60 * 1000;

/** ¿Se puede volver a `instanteMs`? Tiene que ser pasado, de los últimos 30 días. */
export function esInstanteDeLaVentana(instanteMs: number, ahoraMs: number): boolean {
	return instanteMs < ahoraMs && instanteMs >= ahoraMs - VENTANA_DE_VUELTA_MS;
}

/** Lo más largo que se admite como marcador: los de Cloudflare tienen 59 letras. */
const TOPE_DEL_MARCADOR = 100;

/**
 * ¿Puede ser `texto` un marcador de la plataforma? Cloudflare los da en cifras hexadecimales en
 * minúsculas, en grupos separados por guiones: `0000007b-0000b26e-00001538-0c3e87bb37b3db5cc52eedb93cd3b96b`
 * (el ejemplo de su documentación, arriba; los de D1 tienen la misma forma). Lo que no la tenga no es
 * un marcador, y no llega ni a la plataforma ni al rastro de la administración.
 */
export function esMarcador(texto: string): boolean {
	return texto.length <= TOPE_DEL_MARCADOR && /^[0-9a-f]+(?:-[0-9a-f]+)*$/.test(texto);
}

/** ¿Es el fallo de una plataforma sin vuelta a un instante (local, los tests)? */
export function esSinVueltaAUnInstante(e: unknown): boolean {
	return /point-in-time recovery/i.test(String((e as Error)?.message ?? e));
}
