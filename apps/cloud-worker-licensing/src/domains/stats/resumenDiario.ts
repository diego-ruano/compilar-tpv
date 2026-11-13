// src/domains/stats/resumenDiario.ts
//
// El resumen diario de las estadísticas (`_Estad_Producto_Dia`, `_Estad_Mesa_Dia` y
// `_Estad_Dias_Sucios`, §17 de `0001_inicial.sql`), en la base del negocio que vive en su TenantHub.
//
// Las estadísticas de productos y de mesas de una semana, un mes o un año leen de ahí los días ya
// cerrados, y de los cobros sólo lo de hoy (`stats.queries.ts`). Recorrer los cobros de un año de un
// bar de mucho movimiento tardaba segundos, y mientras tanto el Durable Object, que es un solo hilo,
// no atendía a nadie más de ese negocio.
//
// Es una caché: todo sale de `Pagos`, `Pago_Detalles`, `Detalle_Comanda` y `Comandas`. No se
// replica ni viaja en un volcado, y la Main mantiene la suya con las mismas sentencias
// (`crates/tpv-infra-sqlite/src/estadisticas_diarias.rs`). Por eso estas tablas son estado propio
// de la nube: se escriben sin pasar por el motor, dentro del DO con el cliente de al lado y, si la
// ruta corre en el Worker, por `anotarEstado` (`TABLAS_DE_ESTADO`, en `tenantHub.sqlite.ts`).
//
// Quién hace qué:
//
// - Los triggers del esquema apuntan en `_Estad_Dias_Sucios` el día que cambia. No calculan.
// - `recalcularDia` rehace un día: borra sus filas, las inserta con las dos sentencias compartidas
//   (`packages/database/estadisticas/`) y le quita la marca, en un lote todo o nada.
// - `resumenAlDia` lo hace con los días sucios del rango que se va a leer, antes de leerlo, y de
//   paso contrasta un día ya resumido con los cobros (`contrastarUnDia`).

import type { Client } from "@libsql/client/web";

import selectMesaDia from "../../../../../packages/database/estadisticas/mesa_dia.sql";
import selectProductoDia from "../../../../../packages/database/estadisticas/producto_dia.sql";

import { recortar } from "../../lib/texto";
import { capturarError } from "../../observability/errors";

/** Sin los comentarios: una sentencia de estado no lleva más `;` que el del final, y son texto de más. */
function sinComentarios(sql: string): string {
	return recortar(sql.replace(/--[^\n]*/g, ""));
}

/**
 * Lo vendido de cada día de `dias(Dia)`, por producto y nombre de línea. La misma que lee la Main.
 * Quien la usa le pone delante `dias`: un día para rehacerlo, o los días sucios de un rango para
 * leerlos de los cobros (`stats.queries.ts`).
 */
export const SELECT_PRODUCTO_DIA = sinComentarios(selectProductoDia);

/** Los cobros de cada día de `dias(Dia)` de las comandas de cada mesa. La misma que lee la Main. */
export const SELECT_MESA_DIA = sinComentarios(selectMesaDia);

/** Un solo día, el `?1`, como `dias` de las dos sentencias de arriba. */
const UN_DIA = "WITH dias(Dia) AS (SELECT ?1)";

/** Las columnas de cada tabla, en el orden en que las devuelve su sentencia. */
const COLUMNAS_PRODUCTO = "Dia, ID_Producto, Nombre_Producto, Milesimas";
const COLUMNAS_MESA = "Dia, ID_Mesa, Importe, Comandas, Comandas_Ultimo_Mes, Comandas_Ultimo";

type Sentencia = { sql: string; args: unknown[] };

/** Las sentencias que rehacen el resumen de `dia` y le quitan la marca, en orden. */
export function sentenciasDeRecalculo(dia: string): Sentencia[] {
	return [
		"DELETE FROM _Estad_Producto_Dia WHERE Dia = ?1",
		`INSERT INTO _Estad_Producto_Dia (${COLUMNAS_PRODUCTO})\n${UN_DIA}\n${SELECT_PRODUCTO_DIA}`,
		"DELETE FROM _Estad_Mesa_Dia WHERE Dia = ?1",
		`INSERT INTO _Estad_Mesa_Dia (${COLUMNAS_MESA})\n${UN_DIA}\n${SELECT_MESA_DIA}`,
		"DELETE FROM _Estad_Dias_Sucios WHERE Dia = ?1",
	].map((sql) => ({ sql, args: [dia] }));
}

/**
 * Rehace el resumen de un día y le quita la marca, todo o nada.
 *
 * Va en un lote: dentro del DO es una transacción síncrona y nada se intercala, así que la marca
 * que se quita es la de lo que se acaba de calcular. Un cambio posterior la vuelve a poner.
 */
export async function recalcularDia(db: Client, dia: string): Promise<void> {
	await db.batch(sentenciasDeRecalculo(dia) as any, "write");
}

/**
 * Cuántas filas distinguen lo guardado de un día de lo que sale de los cobros: las que sobran, las
 * que faltan y las repetidas. Todo es exacto: las unidades van en milésimas enteras.
 *
 * Un día apuntado como sucio da 0: ya se sabe que no vale, y no es un trigger que falte. Se mira en
 * la misma sentencia que compara, para que un cobro que entre entre medias (con la ruta en el
 * Worker, cada sentencia es un viaje al DO) no pase por un descuadre.
 */
function sqlDiferencias(tabla: string, columnas: string, calculado: string): string {
	// Las dos van materializadas: lo que sale de los cobros se calcula una vez y se lee tres.
	return `WITH
		guardado AS MATERIALIZED (SELECT ${columnas} FROM ${tabla} WHERE Dia = ?1),
		calculado AS MATERIALIZED (SELECT ${columnas} FROM (${UN_DIA} ${calculado}))
		SELECT CASE WHEN EXISTS (SELECT 1 FROM _Estad_Dias_Sucios WHERE Dia = ?1) THEN 0 ELSE
		  (SELECT COUNT(*) FROM (SELECT * FROM guardado EXCEPT SELECT * FROM calculado))
		+ (SELECT COUNT(*) FROM (SELECT * FROM calculado EXCEPT SELECT * FROM guardado))
		+ ABS((SELECT COUNT(*) FROM guardado) - (SELECT COUNT(*) FROM calculado)) END AS diferencias;`;
}

const DIFERENCIAS_PRODUCTO = sqlDiferencias(
	"_Estad_Producto_Dia",
	"ID_Producto, Nombre_Producto, Milesimas",
	SELECT_PRODUCTO_DIA,
);

const DIFERENCIAS_MESA = sqlDiferencias(
	"_Estad_Mesa_Dia",
	"ID_Mesa, Importe, Comandas, Comandas_Ultimo_Mes, Comandas_Ultimo",
	SELECT_MESA_DIA,
);

function primera(rs: any): Record<string, unknown> {
	const fila = rs?.rows?.[0];
	if (!fila) return {};
	if (typeof fila === "object" && !Array.isArray(fila)) return fila;
	const o: Record<string, unknown> = {};
	(rs.columns as string[]).forEach((col, i) => {
		o[col] = fila[i];
	});
	return o;
}

/** ¿Coincide lo guardado de `dia` con lo que sale ahora de los cobros? */
export async function coincideElDia(db: Client, dia: string): Promise<boolean> {
	const productos = primera(await db.execute({ sql: DIFERENCIAS_PRODUCTO, args: [dia] }));
	const mesas = primera(await db.execute({ sql: DIFERENCIAS_MESA, args: [dia] }));
	return Number(productos.diferencias ?? 0) === 0 && Number(mesas.diferencias ?? 0) === 0;
}

/**
 * El vigía del resumen en la nube: contrasta con los cobros un día ya resumido del rango que se va
 * a leer, elegido al azar. Si no coincide es que un cambio no dejó su marca (falta un trigger): se
 * rehace en el acto y se avisa. La Main hace lo mismo cada día desde su job de reconciliación.
 *
 * Devuelve el día que no cuadraba, o `null`.
 */
export async function contrastarUnDia(db: Client, inicioSql: string): Promise<string | null> {
	// Un día cualquiera entre el inicio del rango y ayer; sin días cerrados en el rango sale hoy, y
	// la condición de abajo lo deja fuera. Un día sucio no se mira: ya se sabe que no vale.
	const elegido = primera(
		await db.execute(`
			SELECT dia FROM (
				SELECT date(${inicioSql}, '+' || ((random() & 1048575) % MAX(1, CAST(
					julianday(date('now','localtime')) - julianday(date(${inicioSql})) AS INTEGER
				))) || ' days') AS dia
			)
			WHERE dia < date('now','localtime')
			  AND dia NOT IN (SELECT Dia FROM _Estad_Dias_Sucios);`),
	);
	const dia = elegido.dia == null ? null : String(elegido.dia);
	if (!dia || (await coincideElDia(db, dia))) return null;

	await recalcularDia(db, dia);
	const aviso = new Error(`El resumen diario de las estadísticas no cuadraba con los cobros (${dia})`);
	capturarError(aviso, "stats.resumen_diario");
	console.warn(`[stats] ${aviso.message}: rehecho`);
	return dia;
}

/**
 * Suelta el hilo un momento. Dentro del Durable Object una ruta no cede el paso mientras no espere
 * algo de verdad (el SQLite de al lado contesta en el acto), y rehacer muchos días seguidos lo
 * dejaría sin atender a nadie más del negocio todo ese rato.
 */
function cederElPaso(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Deja al día el resumen de los días que va a leer una estadística: los sucios desde `inicioSql`
 * (la expresión SQL del inicio del rango) hasta ayer. Hoy no se lee del resumen.
 *
 * Lo normal es que no haya ninguno, o ayer. Muchos los deja un cambio que toca días viejos (borrar
 * del catálogo un producto con historia apunta todos los días en que se vendió), y entonces cada día
 * se rehace por separado y entre uno y otro se cede el paso: lo que tarda lo espera esta lectura, no
 * el resto del negocio.
 */
export async function resumenAlDia(db: Client, inicioSql: string): Promise<void> {
	const sucios = await db.execute(`
		SELECT Dia AS dia FROM _Estad_Dias_Sucios
		WHERE Dia >= date(${inicioSql}) AND Dia < date('now','localtime')
		ORDER BY Dia DESC;`);
	for (const fila of (sucios.rows ?? []) as any[]) {
		const dia = String((Array.isArray(fila) ? fila[0] : fila.dia) ?? "");
		if (!dia) continue;
		await recalcularDia(db, dia);
		await cederElPaso();
	}
	await contrastarUnDia(db, inicioSql);
}
