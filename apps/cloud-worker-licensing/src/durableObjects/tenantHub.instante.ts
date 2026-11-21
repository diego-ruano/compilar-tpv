// src/durableObjects/tenantHub.instante.ts
//
// DO-03 · Devolver la base de un negocio a un instante, y lo que hay que hacer después con el log.
//
// El SQLite de un Durable Object guarda 30 días de historia y Cloudflare lo puede devolver a
// cualquier punto de ellos (point-in-time recovery,
// https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api):
//
// - `getBookmarkForTime(instante)` da el marcador de ese instante, y `getCurrentBookmark()` el de ahora.
// - `onNextSessionRestoreBookmark(marcador)` deja la vuelta preparada para el siguiente arranque del
//   objeto y devuelve el marcador de justo antes de volver, con el que se deshace.
// - `ctx.abort()` reinicia el objeto, y al arrancar vuelve. Se lleva **todo** lo guardado: el SQL y
//   lo que va por `put()`. La alarma, la documentación no lo dice: se vuelve a armar al primer acceso.
//
// No está en local ni en los tests («not supported in local development»: workerd lanza «This
// Durable Object's storage back-end does not implement point-in-time recovery»). Por eso va detrás
// de `Instantes`, que un test sustituye por un doble; lo de después (`abrirLogTrasVolver`) es SQL
// corriente y se prueba de verdad.
//
// **Lo que no se arregla solo es el log de la réplica.** La Main guarda como checkpoint el último
// `Seq` que le ha llegado, y la nube, devuelta a un instante, vuelve a numerar desde el que tenía
// entonces: sin hacer nada, la Main pediría «desde mi checkpoint», no le llegaría nada de lo nuevo
// con un número que ella ya ha visto, y se quedaría sin esos cambios para siempre. Así que después de
// volver se abre el log por encima de todo lo que se ha numerado nunca (`abrirLogTrasVolver`): un
// cambio vacío, sin sentencias, con un `Seq` muy por encima. Y quién manda lo decide quien lo pide
// (`ModoDeVuelta`), porque la nube vuelve atrás y la Main no:
//
// - `nube`: la base de la nube es la buena (se ha estropeado algo y la Main lo tiene también). Lo
//   purgado se pone justo debajo del cambio vacío, por encima de cualquier checkpoint: la Main ve que
//   a su base le falta un tramo que ya no se puede traer (SYNC-32), aparta la suya con su outbox en
//   `backups/antes-de-la-nube-*` y se trae la nube. Las Handy no guardan base.
// - `main`: la Main es la buena (la nube se perdió o se estropeó sola). No se toca lo purgado: la
//   Main sigue con su base, se pone al día por encima del cambio vacío y sube su outbox, y lo que la
//   nube perdió entre el instante y ahora lo sube la Main entera (DO-SUBIDA, `tenantHub.subida.ts`):
//   en la misma transacción que abre el log se apunta la petición de subida completa, sin dueño (la
//   primera Main vigente que salude se la queda), y la Main la ve en su siguiente saludo. Hasta que acaba, la nube va por detrás
//   de la Main.

import { PURGADO_HASTA } from "../domains/sync/cambiosJson";
import { baseAprovisionada } from "./tenantHub.sqlite";
import { olvidarSubida, pedirSubida, type OrigenDeSubida } from "./tenantHub.subida";

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
export const VENTANA_DE_VUELTA_MS = 30 * 24 * 60 * 60 * 1000;

/** ¿Es el fallo de una plataforma sin vuelta a un instante (local, los tests)? */
export function esSinVueltaAUnInstante(e: unknown): boolean {
	return /point-in-time recovery/i.test(String((e as Error)?.message ?? e));
}

export type ModoDeVuelta = "nube" | "main";

/**
 * Cuánto se salta el log tras volver. Basta con pasar de lo que la nube ha numerado nunca, que se
 * lee antes de volver (`seqMasAlto`); el salto es para cuando no se puede leer: un objeto vacío (su
 * base se perdió) no recuerda hasta dónde numeró, y la Main sí. Diez millones de cambios son años de
 * un bar con mucho movimiento, y la vuelta llega como mucho a 30 días.
 */
export const SALTO_DE_SEQ = 10_000_000;

/** La marca que pone «vuelta en curso» en el almacenamiento del objeto. La vuelta se la lleva. */
export const CLAVE_VUELTA_EN_CURSO = "vuelta-en-curso";

/**
 * El `Seq` más alto que sabe esta base: el final del log, el de su autoincremento (lo purgado
 * también cuenta), los checkpoints de las Main y la marca de lo purgado. 0 sin base.
 */
export function seqMasAlto(sql: SqlStorage): number {
	if (!baseAprovisionada(sql)) return 0;
	const fila = sql
		.exec(
			`SELECT MAX(
			   COALESCE((SELECT MAX(Seq) FROM Sync_Changes), 0),
			   COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'Sync_Changes'), 0),
			   COALESCE((SELECT MAX(Last_Seq) FROM Sync_Main_Checkpoints), 0)
			 ) AS s;`,
		)
		.one() as { s: number };
	return Number(fila.s ?? 0);
}

export type LogAbierto = {
	/** El `Seq` del cambio vacío: lo siguiente se numera por encima. */
	inicio: number;
	/** Lo purgado tras volver (sólo cambia con `nube`). */
	purgadoHasta: number | null;
};

/**
 * Abre el log por encima de todo lo numerado (ver la cabecera): un cambio vacío con `Seq` = el más
 * alto que se sabe (`seqAntes`, leído antes de volver, y el de ahora) más `SALTO_DE_SEQ`, y con
 * `nube`, lo purgado justo debajo. Todo o nada.
 */
export function abrirLogTrasVolver(
	storage: DurableObjectStorage,
	opciones: {
		seqAntes: number;
		modo: ModoDeVuelta;
		opId: string;
		ahoraMs: number;
		/** DO-SUBIDA: de dónde sale la base que se acaba de devolver. */
		origen: OrigenDeSubida;
		/** DO-SUBIDA: la Main de la petición, o `null`: la primera Main vigente que salude se la queda. */
		mainDeviceId: string | null;
	},
): LogAbierto {
	const sql = storage.sql;
	return storage.transactionSync(() => {
		const inicio = Math.max(opciones.seqAntes, seqMasAlto(sql)) + SALTO_DE_SEQ;
		sql.exec(
			`INSERT INTO Sync_Changes (Seq, Op_Id, Command_Name, Statements_Json, Device_Id, Created_At_Ms)
			 VALUES (?1, ?2, 'nube_devuelta', '[]', NULL, ?3);`,
			inicio,
			opciones.opId,
			opciones.ahoraMs,
		);
		// DO-SUBIDA: con `main`, la Main tiene que subir su base entera; con `nube`, no hay nada que subir.
		if (opciones.modo !== "nube") {
			pedirSubida(sql, {
				id: opciones.opId,
				origen: opciones.origen,
				mainDeviceId: opciones.mainDeviceId,
				inicioSeq: inicio,
				ahoraMs: opciones.ahoraMs,
			});
			return { inicio, purgadoHasta: null };
		}
		olvidarSubida(sql);
		const purgadoHasta = inicio - 1;
		sql.exec(
			`INSERT INTO Sync_Main_Checkpoints (Device_Id, Last_Seq, Updated_At_Ms) VALUES (?1, ?2, ?3)
			 ON CONFLICT(Device_Id) DO UPDATE SET
			   Last_Seq = MAX(Last_Seq, excluded.Last_Seq),
			   Updated_At_Ms = excluded.Updated_At_Ms;`,
			PURGADO_HASTA,
			purgadoHasta,
			opciones.ahoraMs,
		);
		return { inicio, purgadoHasta };
	});
}
