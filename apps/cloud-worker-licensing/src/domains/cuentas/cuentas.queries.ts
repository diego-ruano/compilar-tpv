// src/domains/cuentas/cuentas.queries.ts

import type { Client } from "@libsql/client/web";
import { deLaBase } from "../../lib/dinero";

import type {
	CierreDto,
	CierreResumenDto,
	CursorCuentas,
	EntradaDto,
	PaginaEntradas,
	PaginaSalidas,
	ResumenCajaDto,
	SalidaDto,
} from "@tpv/contracts";

function rows(rs: any): any[] {
	const cols: string[] = rs?.columns ?? [];
	return (rs?.rows ?? []).map((r: any) => {
		if (r && typeof r === "object" && !Array.isArray(r)) return r;
		const o: Record<string, any> = {};
		cols.forEach((col, i) => {
			o[col] = r[i];
		});
		return o;
	});
}

// El rango de días y, si lo hay, el cursor de la página. Paridad con
// `tpv-infra-sqlite::cuentas::where_listado` (RI-18):
// - `del`/`al` son días y los dos entran: `[del, al + 1 día)`. La función va sobre el PARÁMETRO y no
//   sobre la columna, o el índice por fecha no se puede usar.
// - El cursor deja sólo lo que va DESPUÉS de esa fila en el orden de la lista (fecha DESC, id DESC).
//   Escrito así, y no como `(fecha, id) < (?, ?)`, el índice queda acotado también por arriba.
function rangoWhere(
	del: string | null,
	al: string | null,
	cursor: CursorCuentas | null,
	fechaCol: string,
	idCol: string,
) {
	const parts: string[] = [];
	const args: any[] = [];
	if (del) {
		args.push(del);
		parts.push(`${fechaCol} >= date(?${args.length})`);
	}
	if (al) {
		args.push(al);
		parts.push(`${fechaCol} < date(?${args.length}, '+1 day')`);
	}
	if (cursor) {
		args.push(cursor.fecha);
		const f = args.length;
		args.push(cursor.id);
		const i = args.length;
		parts.push(`${fechaCol} <= ?${f} AND (${fechaCol} < ?${f} OR ${idCol} < ?${i})`);
	}
	return { whereSql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", args };
}

// Pide UNA fila de más para saber si hay página siguiente sin contar; `cortarPagina` la quita y
// devuelve el cursor de la última que sí se enseña.
function cortarPagina<T extends { id: string }>(
	filas: (T & { orden: string })[],
	pageSize: number | null,
): { filas: T[]; siguiente: CursorCuentas | null } {
	const hayMas = pageSize != null && pageSize > 0 && filas.length > pageSize;
	const visibles = hayMas ? filas.slice(0, pageSize!) : filas;
	const ultima = visibles[visibles.length - 1];
	return {
		filas: visibles.map(({ orden: _orden, ...f }) => f as unknown as T),
		siguiente: hayMas && ultima ? { fecha: String(ultima.orden), id: String(ultima.id) } : null,
	};
}

// Añade búsqueda de texto (LIKE sobre las columnas ya calculadas) y paginación a `args`, numerando
// los placeholders de forma consecutiva. Paridad con `tpv-infra-sqlite::cuentas` (CUENTA-05).
function applyFilters(
	args: any[],
	q: string | null,
	expr: string,
	pageSize: number | null,
): { qClause: string; limitClause: string } {
	let qClause = "";
	if (q && q.trim()) {
		args.push(q.trim());
		qClause = `WHERE ${expr} LIKE '%' || lower(?${args.length}) || '%'`;
	}
	let limitClause = "";
	if (pageSize && pageSize > 0) {
		args.push(pageSize + 1);
		limitClause = `LIMIT ?${args.length}`;
	}
	return { qClause, limitClause };
}

const entradasInner = (whereRango: string) => `
	SELECT
		CAST(p.ID_Pago AS TEXT) AS id,
		substr(p.Fecha_Hora, 1, 16) AS fecha_hora,
		p.Fecha_Hora AS orden,
		(
			CASE
				WHEN m.Numero_Mesa = 'BARRA' THEN 'Take away'
				WHEN m.Numero_Mesa IS NOT NULL AND m.Numero_Mesa <> '' THEN 'Mesa ' || m.Numero_Mesa
				ELSE 'Venta'
			END
			||
			CASE
				WHEN cl.Nombre IS NOT NULL AND cl.Nombre <> '' THEN ' / ' || cl.Nombre
				ELSE ''
			END
		) AS cliente,
		CASE WHEN p.Metodo_Pago = 'Tarjeta' THEN 'Tarjeta' ELSE 'Efectivo' END AS metodo,
		IFNULL(p.Importe_Total, 0) AS importe,
		COALESCE(p.Estado, 'ACTIVO') AS estado,
		p.Anulado_En AS anulado_en,
		NULLIF(TRIM(COALESCE(ua.Nombre,'') || CASE WHEN COALESCE(ua.Apellido,'')='' THEN '' ELSE ' ' || ua.Apellido END), '') AS anulado_por,
		p.Motivo_Anulacion AS motivo_anulacion
	FROM Pagos p
	JOIN Comandas c ON c.ID_Comanda = p.ID_Comanda
	LEFT JOIN Mesas m ON m.ID_Mesa = c.ID_Mesa
	LEFT JOIN Reservas r ON r.ID_Reserva = c.ID_Reserva
	-- RI-61: el cliente de la comanda (fijado al cobrar) y, si no, el de su reserva.
	LEFT JOIN Clientes cl ON cl.ID_Cliente = COALESCE(c.ID_Cliente, r.ID_Cliente)
	LEFT JOIN Usuarios ua ON ua.ID_Usuario = p.Anulado_Por
	${whereRango}
`;

const ENTRADAS_Q_EXPR =
	"lower(fecha_hora || ' ' || cliente || ' ' || metodo || ' ' || CAST(importe AS TEXT))";

const salidasInner = (whereRango: string) => `
	SELECT
		CAST(g.ID_Gasto AS TEXT) AS id,
		substr(g.Fecha, 1, 10) AS fecha_hora,
		g.Fecha AS orden,
		g.Tipo_Gasto AS tipo_gasto,
		g.Concepto AS concepto,
		g.Importe AS importe,
		g.ID_Proveedor AS proveedor_id,
		g.Pagado_Con_Caja AS pagado_con_caja,
		IFNULL(pr.Nombre_Empresa, '') AS proveedor_nombre
	FROM Cuentas_Gastos g
	LEFT JOIN Proveedores pr ON pr.ID_Proveedor = g.ID_Proveedor
	${whereRango}
`;

const SALIDAS_Q_EXPR =
	"lower(fecha_hora || ' ' || tipo_gasto || ' ' || concepto || ' ' || CAST(importe AS TEXT) || ' ' || IFNULL(proveedor_id,'') || ' ' || proveedor_nombre)";

export async function entradas(
	db: Client,
	del: string | null,
	al: string | null,
	q: string | null = null,
	pageSize: number | null = null,
	cursor: CursorCuentas | null = null,
): Promise<PaginaEntradas> {
	const { whereSql, args } = rangoWhere(del, al, cursor, "p.Fecha_Hora", "p.ID_Pago");
	const { qClause, limitClause } = applyFilters(args, q, ENTRADAS_Q_EXPR, pageSize);
	// Sin filtro por estado: los cobros anulados SALEN, marcados (CUENTA-07). Es la pantalla
	// donde se investiga un descuadre; quien no los cuenta es `resumen`.
	const rs = await db.execute({
		sql: `
			SELECT id, fecha_hora, cliente, metodo, importe, estado, anulado_en, anulado_por,
			       motivo_anulacion, orden
			FROM (${entradasInner(whereSql)}) AS e
			${qClause}
			ORDER BY orden DESC, id DESC
			${limitClause};
		`,
		args,
	});
	return cortarPagina(rows(rs) as (EntradaDto & { orden: string })[], pageSize);
}

export async function salidas(
	db: Client,
	del: string | null,
	al: string | null,
	q: string | null = null,
	pageSize: number | null = null,
	cursor: CursorCuentas | null = null,
): Promise<PaginaSalidas> {
	const { whereSql, args } = rangoWhere(del, al, cursor, "g.Fecha", "g.ID_Gasto");
	const { qClause, limitClause } = applyFilters(args, q, SALIDAS_Q_EXPR, pageSize);
	const rs = await db.execute({
		sql: `
			SELECT id, fecha_hora, tipo_gasto, concepto, importe, proveedor_id, pagado_con_caja, orden
			FROM (${salidasInner(whereSql)}) AS g
			${qClause}
			ORDER BY orden DESC, id DESC
			${limitClause};
		`,
		args,
	});
	// SQLite guarda el booleano como 0/1; la Main lo devuelve como `bool` y la lectura tiene que ser igual.
	return cortarPagina(
		rows(rs).map((r) => ({ ...r, pagado_con_caja: Number(r.pagado_con_caja ?? 0) !== 0 })) as (SalidaDto & {
			orden: string;
		})[],
		pageSize,
	);
}

// Resumen agregado (totales por método + conteos) sobre TODO el rango + búsqueda, para que la
// cabecera sea correcta aunque la lista esté paginada (CUENTA-05).
export async function resumen(
	db: Client,
	del: string | null,
	al: string | null,
	q: string | null = null,
): Promise<ResumenCajaDto> {
	const eRango = rangoWhere(del, al, null, "p.Fecha_Hora", "p.ID_Pago");
	const { qClause: eQ } = applyFilters(eRango.args, q, ENTRADAS_Q_EXPR, null);
	// Los anulados no cuentan en los totales (un ticket anulado no es una venta) y se cuentan
	// aparte, que es el dato que hace visible la sisa (CUENTA-07).
	const eRs = await db.execute({
		sql: `
			SELECT
				IFNULL(SUM(CASE WHEN estado <> 'ANULADO' THEN importe ELSE 0 END), 0) AS te,
				IFNULL(SUM(CASE WHEN estado <> 'ANULADO' AND metodo = 'Efectivo' THEN importe ELSE 0 END), 0) AS ef,
				IFNULL(SUM(CASE WHEN estado <> 'ANULADO' AND metodo = 'Tarjeta' THEN importe ELSE 0 END), 0) AS ta,
				SUM(CASE WHEN estado <> 'ANULADO' THEN 1 ELSE 0 END) AS ce,
				SUM(CASE WHEN estado =  'ANULADO' THEN 1 ELSE 0 END) AS ca,
				IFNULL(SUM(CASE WHEN estado =  'ANULADO' THEN importe ELSE 0 END), 0) AS tan
			FROM (${entradasInner(eRango.whereSql)}) AS e
			${eQ};
		`,
		args: eRango.args,
	});
	const e = rows(eRs)[0] ?? {};

	const sRango = rangoWhere(del, al, null, "g.Fecha", "g.ID_Gasto");
	const { qClause: sQ } = applyFilters(sRango.args, q, SALIDAS_Q_EXPR, null);
	const sRs = await db.execute({
		sql: `
			SELECT IFNULL(SUM(importe), 0) AS ts, COUNT(*) AS cs
			FROM (${salidasInner(sRango.whereSql)}) AS g
			${sQ};
		`,
		args: sRango.args,
	});
	const s = rows(sRs)[0] ?? {};

	return {
		total_entradas: deLaBase(e.te),
		total_salidas: deLaBase(s.ts),
		total_efectivo: deLaBase(e.ef),
		total_tarjeta: deLaBase(e.ta),
		count_entradas: Number(e.ce ?? 0),
		count_salidas: Number(s.cs ?? 0),
		count_anuladas: Number(e.ca ?? 0),
		total_anulado: deLaBase(e.tan),
	};
}

/* =========================================================
   Cierre de caja (arqueo) — SOLO LECTURA (CUENTA-06)
   La Handy mira el histórico; cerrar y reabrir es de la Main (`soloLaMainEscribeCaja`).
========================================================= */

// El nombre de quien cerró se resuelve aquí y no en la UI: la fila sólo guarda el id, y un LEFT JOIN
// evita que borrar a un usuario haga desaparecer su arqueo.
const CIERRE_COLS = `
	c.ID_Cierre AS id_cierre,
	c.Fecha_Hora AS fecha_hora,
	c.ID_Usuario AS id_usuario,
	NULLIF(TRIM(COALESCE(u.Nombre,'') || CASE WHEN COALESCE(u.Apellido,'')='' THEN '' ELSE ' ' || u.Apellido END), '') AS usuario_nombre,
	c.Fondo_Inicial AS fondo_inicial,
	c.Ventas_Efectivo AS ventas_efectivo,
	c.Esperado AS esperado,
	c.Contado AS contado,
	c.Descuadre AS descuadre,
	c.Dejado AS dejado,
	c.Retirado AS retirado,
	c.Motivo AS motivo,
	c.Reabierto_En AS reabierto_en,
	c.Reabierto_Por AS reabierto_por,
	c.Periodo_Desde AS periodo_desde,
	c.Gastos_Caja AS gastos_caja,
	c.Rect_Ventas_Efectivo AS rect_ventas_efectivo,
	c.Rect_Gastos_Caja AS rect_gastos_caja,
	c.Rect_Esperado AS rect_esperado,
	c.Rect_Descuadre AS rect_descuadre
`;

/** Adjunta el desglose por denominación, separado en los dos momentos del recuento. */
async function conDenominaciones(db: Client, fila: any): Promise<CierreDto> {
	const rs = await db.execute({
		sql: `
			SELECT Momento AS momento, Valor AS valor, Unidades AS unidades
			FROM Cierre_Denominaciones
			WHERE ID_Cierre = ?1
			ORDER BY Momento ASC, Valor ASC;
		`,
		args: [String(fila.id_cierre ?? "")],
	});
	const contado: any[] = [];
	const dejado: any[] = [];
	for (const r of rows(rs)) {
		const item = { valor: Number(r.valor ?? 0), unidades: Number(r.unidades ?? 0) };
		if (String(r.momento ?? "") === "DEJADO") dejado.push(item);
		else contado.push(item);
	}
	// CAJA-01: las correcciones que cambiaron sus números, en el mismo orden que la Main.
	const rr = await db.execute({
		sql: `
			SELECT
				r.ID_Rectificacion AS id_rectificacion,
				r.Fecha_Hora AS fecha_hora,
				NULLIF(TRIM(COALESCE(u.Nombre,'') || CASE WHEN COALESCE(u.Apellido,'')='' THEN '' ELSE ' ' || u.Apellido END), '') AS usuario_nombre,
				r.Descripcion AS descripcion,
				r.Motivo AS motivo,
				r.Esperado_Antes AS esperado_antes,
				r.Esperado_Despues AS esperado_despues,
				r.Descuadre_Antes AS descuadre_antes,
				r.Descuadre_Despues AS descuadre_despues
			FROM Cierre_Rectificaciones r
			LEFT JOIN Usuarios u ON u.ID_Usuario = r.ID_Usuario
			WHERE r.ID_Cierre = ?1
			ORDER BY r.Fecha_Hora ASC, r.ID_Rectificacion ASC;
		`,
		args: [String(fila.id_cierre ?? "")],
	});
	return {
		...fila,
		contado_denoms: contado,
		dejado_denoms: dejado,
		rectificaciones: rows(rr),
	} as CierreDto;
}

/**
 * El último cierre **no reabierto**, que es el que marca dónde empieza el periodo actual.
 *
 * Un cierre reabierto deja de contar como corte, así que el "último" no es el de fecha más alta
 * sino el más reciente que siga cerrado.
 */
export async function ultimoCierre(db: Client): Promise<CierreDto | null> {
	const rs = await db.execute(`
		SELECT ${CIERRE_COLS}
		FROM Cierres_Caja c
		LEFT JOIN Usuarios u ON u.ID_Usuario = c.ID_Usuario
		WHERE c.Reabierto_En IS NULL
		ORDER BY c.Fecha_Hora DESC, c.ID_Cierre DESC
		LIMIT 1;
	`);
	const fila = rows(rs)[0];
	return fila ? conDenominaciones(db, fila) : null;
}

export async function listarCierres(db: Client, limite: number): Promise<CierreResumenDto[]> {
	const rs = await db.execute({
		sql: `
			SELECT
				c.ID_Cierre AS id_cierre,
				c.Fecha_Hora AS fecha_hora,
				NULLIF(TRIM(COALESCE(u.Nombre,'') || CASE WHEN COALESCE(u.Apellido,'')='' THEN '' ELSE ' ' || u.Apellido END), '') AS usuario_nombre,
				c.Esperado AS esperado,
				c.Contado AS contado,
				c.Descuadre AS descuadre,
				c.Retirado AS retirado,
				c.Motivo AS motivo,
				c.Reabierto_En AS reabierto_en,
				c.Rect_Esperado AS rect_esperado,
				c.Rect_Descuadre AS rect_descuadre
			FROM Cierres_Caja c
			LEFT JOIN Usuarios u ON u.ID_Usuario = c.ID_Usuario
			ORDER BY c.Fecha_Hora DESC, c.ID_Cierre DESC
			LIMIT ?1;
		`,
		args: [limite > 0 ? limite : 50],
	});
	return rows(rs) as CierreResumenDto[];
}

export async function detalleCierre(db: Client, idCierre: string): Promise<CierreDto | null> {
	const rs = await db.execute({
		sql: `
			SELECT ${CIERRE_COLS}
			FROM Cierres_Caja c
			LEFT JOIN Usuarios u ON u.ID_Usuario = c.ID_Usuario
			WHERE c.ID_Cierre = ?1
			LIMIT 1;
		`,
		args: [idCierre],
	});
	const fila = rows(rs)[0];
	return fila ? conDenominaciones(db, fila) : null;
}
