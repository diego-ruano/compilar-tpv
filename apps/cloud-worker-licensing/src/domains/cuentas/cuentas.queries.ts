// src/domains/cuentas/cuentas.queries.ts

import type { Client } from "@libsql/client/web";

import type {
	CierreDto,
	CierreResumenDto,
	EntradaDto,
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

function rangoWhere(del: string | null, al: string | null, fechaExpr: string) {
	const parts: string[] = [];
	const args: any[] = [];
	if (del) {
		args.push(del);
		parts.push(`date(${fechaExpr}) >= date(?${args.length})`);
	}
	if (al) {
		args.push(al);
		parts.push(`date(${fechaExpr}) <= date(?${args.length})`);
	}
	return { whereSql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", args };
}

// Añade búsqueda de texto (LIKE sobre las columnas ya calculadas) y paginación a `args`, numerando
// los placeholders de forma consecutiva. Paridad con `tpv-infra-sqlite::cuentas` (CUENTA-05).
function applyFilters(
	args: any[],
	q: string | null,
	expr: string,
	page: number | null,
	pageSize: number | null,
): { qClause: string; limitClause: string } {
	let qClause = "";
	if (q && q.trim()) {
		args.push(q.trim());
		qClause = `WHERE ${expr} LIKE '%' || lower(?${args.length}) || '%'`;
	}
	let limitClause = "";
	if (pageSize && pageSize > 0) {
		const pg = Math.max(1, page ?? 1);
		args.push(pageSize);
		const li = args.length;
		args.push((pg - 1) * pageSize);
		const oi = args.length;
		limitClause = `LIMIT ?${li} OFFSET ?${oi}`;
	}
	return { qClause, limitClause };
}

const entradasInner = (whereRango: string) => `
	SELECT
		CAST(p.ID_Pago AS TEXT) AS id,
		substr(p.Fecha_Hora, 1, 16) AS fecha_hora,
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
		IFNULL(p.Importe_Total, 0) AS importe
	FROM Pagos p
	JOIN Comandas c ON c.ID_Comanda = p.ID_Comanda
	LEFT JOIN Mesas m ON m.ID_Mesa = c.ID_Mesa
	LEFT JOIN Reservas r ON r.ID_Reserva = c.ID_Reserva
	LEFT JOIN Clientes cl ON cl.ID_Cliente = r.ID_Cliente
	${whereRango}
`;

const ENTRADAS_Q_EXPR =
	"lower(fecha_hora || ' ' || cliente || ' ' || metodo || ' ' || CAST(importe AS TEXT))";

const salidasInner = (whereRango: string) => `
	SELECT
		CAST(g.ID_Gasto AS TEXT) AS id,
		substr(g.Fecha, 1, 10) AS fecha_hora,
		g.Tipo_Gasto AS tipo_gasto,
		g.Concepto AS concepto,
		g.Importe AS importe,
		g.ID_Proveedor AS proveedor_id,
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
	page: number | null = null,
	pageSize: number | null = null,
): Promise<EntradaDto[]> {
	const { whereSql, args } = rangoWhere(del, al, "p.Fecha_Hora");
	const { qClause, limitClause } = applyFilters(args, q, ENTRADAS_Q_EXPR, page, pageSize);
	const rs = await db.execute({
		sql: `
			SELECT id, fecha_hora, cliente, metodo, importe
			FROM (${entradasInner(whereSql)}) AS e
			${qClause}
			ORDER BY fecha_hora DESC, id DESC
			${limitClause};
		`,
		args,
	});
	return rows(rs) as EntradaDto[];
}

export async function salidas(
	db: Client,
	del: string | null,
	al: string | null,
	q: string | null = null,
	page: number | null = null,
	pageSize: number | null = null,
): Promise<SalidaDto[]> {
	const { whereSql, args } = rangoWhere(del, al, "g.Fecha");
	const { qClause, limitClause } = applyFilters(args, q, SALIDAS_Q_EXPR, page, pageSize);
	const rs = await db.execute({
		sql: `
			SELECT id, fecha_hora, tipo_gasto, concepto, importe, proveedor_id
			FROM (${salidasInner(whereSql)}) AS g
			${qClause}
			ORDER BY fecha_hora DESC, id DESC
			${limitClause};
		`,
		args,
	});
	return rows(rs) as SalidaDto[];
}

// Resumen agregado (totales por método + conteos) sobre TODO el rango + búsqueda, para que la
// cabecera sea correcta aunque la lista esté paginada (CUENTA-05).
export async function resumen(
	db: Client,
	del: string | null,
	al: string | null,
	q: string | null = null,
): Promise<ResumenCajaDto> {
	const eRango = rangoWhere(del, al, "p.Fecha_Hora");
	const { qClause: eQ } = applyFilters(eRango.args, q, ENTRADAS_Q_EXPR, null, null);
	const eRs = await db.execute({
		sql: `
			SELECT
				IFNULL(SUM(importe), 0) AS te,
				IFNULL(SUM(CASE WHEN metodo = 'Efectivo' THEN importe ELSE 0 END), 0) AS ef,
				IFNULL(SUM(CASE WHEN metodo = 'Tarjeta' THEN importe ELSE 0 END), 0) AS ta,
				COUNT(*) AS ce
			FROM (${entradasInner(eRango.whereSql)}) AS e
			${eQ};
		`,
		args: eRango.args,
	});
	const e = rows(eRs)[0] ?? {};

	const sRango = rangoWhere(del, al, "g.Fecha");
	const { qClause: sQ } = applyFilters(sRango.args, q, SALIDAS_Q_EXPR, null, null);
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
		total_entradas: Number(e.te ?? 0),
		total_salidas: Number(s.ts ?? 0),
		total_efectivo: Number(e.ef ?? 0),
		total_tarjeta: Number(e.ta ?? 0),
		count_entradas: Number(e.ce ?? 0),
		count_salidas: Number(s.cs ?? 0),
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
	c.Reabierto_Por AS reabierto_por
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
	return { ...fila, contado_denoms: contado, dejado_denoms: dejado } as CierreDto;
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
				c.Reabierto_En AS reabierto_en
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
