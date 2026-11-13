// src/domains/sync/puntoDePartida.ts
//
// Lo que leen de la base del negocio, antes de nada, las fotos de sync que trabajan con la ventana
// de la fase 1 (`bootstrap.ventana.ts`): la recuperación (`/v1/sync/bootstrap`) y el contraste
// (`/v1/sync/verificar/*`). Las tablas de negocio que hay, la hora del último cierre de caja —de la
// que sale el borde de la ventana— y el `Seq` del final del log.

import { esTablaDeNegocio, esTransaccional, sentenciaConteo } from "./bootstrap.ventana";
import { primerValor, siguiente, type Lector, type Resultado, type Sentencia } from "./volcado";

const SQL_TABLAS: Sentencia = {
	sql: "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC;",
	args: [],
};

const SQL_ULTIMO_CIERRE: Sentencia = {
	sql: `SELECT Fecha_Hora FROM Cierres_Caja WHERE Reabierto_En IS NULL
	      ORDER BY Fecha_Hora DESC LIMIT 1;`,
	args: [],
};

/** El `Seq` del final del log: el de la última escritura aplicada, o 0 con el log vacío. */
export const SQL_SEQ: Sentencia = { sql: "SELECT COALESCE(MAX(Seq), 0) AS seq FROM Sync_Changes;", args: [] };

/** Las tablas de negocio y la hora del último cierre no reabierto: de dónde sale la ventana. */
export function leerPuntoDePartida(lector: Lector): Promise<{ tablas: string[]; ultimoCierre: string | null }> {
	return lector.foto([SQL_TABLAS, SQL_ULTIMO_CIERRE], (rs) => {
		const tablas = [...siguiente(rs).filas].map((f) => String(f[0] ?? "")).filter(esTablaDeNegocio);
		const cierre = primerValor(siguiente(rs));
		return { tablas, ultimoCierre: cierre == null ? null : String(cierre) };
	});
}

/** El `Seq` que devuelve `SQL_SEQ`. */
export function seqDe(r: Resultado): number {
	return Number(primerValor(r) ?? 0);
}

/**
 * Cuenta ventanas de una misma base: EXACTAMENTE las filas que entrarían de cada tabla (con las
 * sentencias del volcado, no la tabla entera). Las maestras no dependen de la ventana y se cuentan
 * una vez.
 */
export function contadorDeVentanas(lector: Lector, tablas: string[]): (desde: string) => Promise<Map<string, number>> {
	const deMaestras = new Map<string, number>();
	return async (desde) => {
		const porContar = tablas.filter((t) => esTransaccional(t) || !deMaestras.has(t));
		const contadas = await lector.foto(
			porContar.map((t) => sentenciaConteo(t, desde)),
			(rs) => new Map(porContar.map((t) => [t, Number(primerValor(siguiente(rs)) ?? 0)])),
		);
		for (const [t, n] of contadas) if (!esTransaccional(t)) deMaestras.set(t, n);
		return new Map(tablas.map((t) => [t, contadas.get(t) ?? deMaestras.get(t) ?? 0]));
	};
}
