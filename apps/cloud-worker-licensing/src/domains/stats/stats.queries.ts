// src/domains/stats/stats.queries.ts

import type { Client } from "@libsql/client/web";

import type {
	ClientesStatsResponse,
	MesasStatsResponse,
	ProductosStatsResponse,
	ProveedoresStatsResponse,
	ReservasStatsResponse,
	StatsCategoriaRow,
	StatsTurno,
	TrabajadoresStatsResponse,
} from "@tpv/contracts";

import type { StatsRange } from "./stats.schemas";

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

function num(v: any, fallback = 0): number {
	const n = Number(v);
	return Number.isFinite(n) ? n : fallback;
}

function rangeBounds(range: StatsRange): { start: string; end: string } {
	if (range === "semana") {
		return {
			start: "datetime('now','localtime','-6 days','start of day')",
			end: "datetime('now','localtime')",
		};
	}
	if (range === "mes") {
		return {
			start: "datetime('now','localtime','start of month')",
			end: "datetime('now','localtime')",
		};
	}
	if (range === "anio") {
		return {
			start: "datetime('now','localtime','start of year')",
			end: "datetime('now','localtime')",
		};
	}
	return {
		start: "datetime('now','localtime','start of day')",
		end: "datetime('now','localtime')",
	};
}

function bucket(range: StatsRange, expr: string): string {
	if (range === "hoy") return `strftime('%H', ${expr})`;
	if (range === "anio") return `strftime('%m/%Y', ${expr})`;
	return `strftime('%d/%m', ${expr})`;
}

async function one(db: Client, sql: string, args: any[] = []): Promise<any> {
	const rs = await db.execute({ sql, args });
	return rows(rs)[0] ?? {};
}

async function tableExists(db: Client, table: string): Promise<boolean> {
	const r = await one(
		db,
		"SELECT name FROM sqlite_master WHERE type='table' AND name=?1 LIMIT 1;",
		[table],
	);
	return Boolean(r.name);
}

export async function mesas(
	db: Client,
	range: StatsRange,
): Promise<MesasStatsResponse> {
	const { start, end } = rangeBounds(range);
	const b = bucket(range, "p.Fecha_Hora");

	const total = await one(
		db,
		"SELECT COUNT(*) AS n FROM Mesas WHERE COALESCE(Es_Sistema,0)=0;",
	);
	const ingresos = await one(
		db,
		`SELECT ROUND(COALESCE(SUM(Importe_Total),0),2) AS total, COUNT(DISTINCT ID_Comanda) AS comandas
		 FROM Pagos p
		 WHERE p.Fecha_Hora >= ${start} AND p.Fecha_Hora < ${end};`,
	);
	const top = await one(
		db,
		`SELECT m.Numero_Mesa AS mesa, z.Nombre_Zona AS zona, COUNT(DISTINCT p.ID_Comanda) AS comandas
		 FROM Pagos p
		 JOIN Comandas c ON c.ID_Comanda = p.ID_Comanda
		 JOIN Mesas m ON m.ID_Mesa = c.ID_Mesa
		 JOIN Zonas z ON z.ID_Zona = m.ID_Zona
		 WHERE p.Fecha_Hora >= ${start} AND p.Fecha_Hora < ${end}
		   AND COALESCE(m.Es_Sistema,0)=0
		 GROUP BY m.ID_Mesa
		 ORDER BY comandas DESC, m.Numero_Mesa ASC
		 LIMIT 1;`,
	);
	const servRs = await db.execute(
		`SELECT ${b} AS label, COUNT(DISTINCT p.ID_Comanda) AS value
		 FROM Pagos p
		 WHERE p.Fecha_Hora >= ${start} AND p.Fecha_Hora < ${end}
		 GROUP BY label ORDER BY label ASC;`,
	);
	const topRs = await db.execute(
		`SELECT m.Numero_Mesa AS mesa, z.Nombre_Zona AS zona, ROUND(SUM(p.Importe_Total),2) AS total
		 FROM Pagos p
		 JOIN Comandas c ON c.ID_Comanda = p.ID_Comanda
		 JOIN Mesas m ON m.ID_Mesa = c.ID_Mesa
		 JOIN Zonas z ON z.ID_Zona = m.ID_Zona
		 WHERE p.Fecha_Hora >= ${start} AND p.Fecha_Hora < ${end}
		   AND COALESCE(m.Es_Sistema,0)=0
		 GROUP BY m.ID_Mesa
		 ORDER BY total DESC LIMIT 10;`,
	);
	const servicios = rows(servRs);
	const topMesas = rows(topRs);
	const comandas = num(ingresos.comandas);

	return {
		total_mesas: num(total.n),
		ocupadas: comandas,
		ticket_medio_por_mesa: comandas > 0 ? Math.round((num(ingresos.total) / comandas) * 100) / 100 : 0,
		mesa_top_comandas: top.mesa
			? { mesa: String(top.mesa), zona: String(top.zona ?? ""), comandas: num(top.comandas) }
			: null,
		servicios: {
			labels: servicios.map((r) => String(r.label ?? "")),
			values: servicios.map((r) => num(r.value)),
		},
		top_mesas_ingresos: topMesas.map((r) => ({
			mesa: String(r.mesa ?? ""),
			zona: String(r.zona ?? ""),
			total: num(r.total),
		})),
	};
}

export async function listCategorias(db: Client): Promise<StatsCategoriaRow[]> {
	const rs = await db.execute(`
		SELECT ID_Categoria, Nombre
		FROM Categorias_Producto
		WHERE COALESCE(Vendible,1)=1
		ORDER BY Nombre ASC;
	`);
	return rows(rs) as StatsCategoriaRow[];
}

export async function productos(
	db: Client,
	range: StatsRange,
	categoriaTopId: string | null,
	categoriaWorstId: string | null,
): Promise<ProductosStatsResponse> {
	const { start, end } = rangeBounds(range);
	const base = `
		FROM Detalle_Comanda dc
		JOIN Pago_Detalles pd ON pd.ID_Detalle = dc.ID_Detalle
		JOIN Pagos p ON p.ID_Pago = pd.ID_Pago
		JOIN Productos pr ON pr.ID_Producto = dc.ID_Producto
		JOIN Categorias_Producto cat ON cat.ID_Categoria = pr.ID_Categoria
		WHERE p.Fecha_Hora >= ${start}
			AND p.Fecha_Hora < ${end}
			AND COALESCE(cat.Vendible,1)=1
	`;
	const best = await one(
		db,
		`SELECT pr.Nombre AS nombre, SUM(COALESCE(dc.Cantidad,1)) AS unidades
		 ${base}
		 GROUP BY pr.ID_Producto
		 ORDER BY unidades DESC, pr.Nombre ASC LIMIT 1;`,
	);
	const worst = await one(
		db,
		`SELECT pr.Nombre AS nombre, SUM(COALESCE(dc.Cantidad,1)) AS unidades
		 ${base}
		 GROUP BY pr.ID_Producto
		 ORDER BY unidades ASC, pr.Nombre ASC LIMIT 1;`,
	);
	const topFilter = categoriaTopId && categoriaTopId.trim() ? "AND pr.ID_Categoria = ?1" : "";
	const worstFilter =
		categoriaWorstId && categoriaWorstId.trim() ? "AND pr.ID_Categoria = ?1" : "";
	const topRs = await db.execute({
		sql: `SELECT pr.Nombre AS label, CAST(ROUND(SUM(COALESCE(dc.Cantidad,1)),0) AS INTEGER) AS value
		      ${base} ${topFilter}
		      GROUP BY pr.ID_Producto ORDER BY value DESC, pr.Nombre ASC LIMIT 10;`,
		args: topFilter ? [categoriaTopId] : [],
	});
	const worstRs = await db.execute({
		sql: `SELECT pr.Nombre AS label, CAST(ROUND(SUM(COALESCE(dc.Cantidad,1)),0) AS INTEGER) AS value
		      ${base} ${worstFilter}
		      GROUP BY pr.ID_Producto ORDER BY value ASC, pr.Nombre ASC LIMIT 10;`,
		args: worstFilter ? [categoriaWorstId] : [],
	});
	const top = rows(topRs);
	const worstRows = rows(worstRs);
	return {
		mejor_producto: best.nombre ? String(best.nombre) : null,
		peor_producto_vendible: worst.nombre ? String(worst.nombre) : null,
		top10_mejores: { labels: top.map((r) => String(r.label ?? "")), values: top.map((r) => num(r.value)) },
		top10_peores: { labels: worstRows.map((r) => String(r.label ?? "")), values: worstRows.map((r) => num(r.value)) },
	};
}

export async function reservas(
	db: Client,
	range: StatsRange,
	turno: StatsTurno,
): Promise<ReservasStatsResponse> {
	const { start, end } = rangeBounds(range);
	const dt = "datetime(r.Dia_YMD || ' ' || COALESCE(r.Hora,'00:00'))";
	const b = bucket(range, dt);
	const turnoFilter =
		turno === "COMIDA"
			? "AND time(r.Hora) < time('17:00')"
			: turno === "CENA"
				? "AND time(r.Hora) >= time('17:00')"
				: "";
	const total = await one(
		db,
		`SELECT COUNT(*) AS total, SUM(CASE WHEN UPPER(COALESCE(Estado,''))='CANCELADA' THEN 1 ELSE 0 END) AS cancelaciones
		 FROM Reservas r WHERE ${dt} >= ${start} AND ${dt} < ${end} ${turnoFilter};`,
	);
	const bucketRs = await db.execute(
		`SELECT ${b} AS label, COUNT(*) AS value FROM Reservas r
		 WHERE ${dt} >= ${start} AND ${dt} < ${end} ${turnoFilter}
		 GROUP BY label ORDER BY label ASC;`,
	);
	const estadoRs = await db.execute(
		`SELECT COALESCE(Estado,'SIN_ESTADO') AS label, COUNT(*) AS value FROM Reservas r
		 WHERE ${dt} >= ${start} AND ${dt} < ${end} ${turnoFilter}
		 GROUP BY label ORDER BY label ASC;`,
	);
	const franjasRs = await db.execute(
		`SELECT substr(COALESCE(Hora,'00:00'),1,2) AS label, COUNT(*) AS value FROM Reservas r
		 WHERE ${dt} >= ${start} AND ${dt} < ${end} ${turnoFilter}
		 GROUP BY label ORDER BY label ASC;`,
	);
	const mesasTurno = await one(
		db,
		`SELECT COUNT(DISTINCT ID_Mesa) AS reservadas FROM Reservas r
		 WHERE ${dt} >= ${start} AND ${dt} < ${end} ${turnoFilter};`,
	);
	const totalMesas = await one(
		db,
		"SELECT COUNT(*) AS total FROM Mesas WHERE COALESCE(Es_Sistema,0)=0;",
	);
	const br = rows(bucketRs);
	const er = rows(estadoRs);
	const fr = rows(franjasRs);
	const reservadas = num(mesasTurno.reservadas);
	return {
		total_reservas: num(total.total),
		cancelaciones: num(total.cancelaciones),
		mesas_turno: {
			turno,
			mesas_reservadas: reservadas,
			mesas_no_reservadas: Math.max(0, num(totalMesas.total) - reservadas),
		},
		reservas_por_bucket: { labels: br.map((r) => String(r.label ?? "")), values: br.map((r) => num(r.value)) },
		estado: { labels: er.map((r) => String(r.label ?? "")), values: er.map((r) => num(r.value)) },
		franjas: { labels: fr.map((r) => String(r.label ?? "")), values: fr.map((r) => num(r.value)) },
	};
}

export async function trabajadores(
	db: Client,
	_range: StatsRange,
): Promise<TrabajadoresStatsResponse> {
	const rs = await db.execute(`
		SELECT t.ID_Trabajador AS id, COALESCE(u.Nombre,'') || CASE WHEN u.Apellido IS NULL THEN '' ELSE ' ' || u.Apellido END AS nombre, COALESCE(t.Puesto,'') AS rol
		FROM Trabajadores t
		JOIN Usuarios u ON u.ID_Usuario = t.ID_Usuario
		WHERE COALESCE(u.Estado,'Activo')='Activo'
		ORDER BY nombre ASC;
	`);
	const cards = rows(rs).map((r) => ({
		id_trabajador: String(r.id ?? ""),
		nombre: String(r.nombre ?? ""),
		rol: String(r.rol ?? ""),
		tareas_asignadas: 0,
		tareas_finalizadas: 0,
		puntualidad: null,
		horas_trabajadas: 0,
	}));
	return {
		cocineros: cards.filter((c) => c.rol.toLowerCase().includes("cocin")),
		camareros: cards.filter((c) => c.rol.toLowerCase().includes("camar")),
		limpieza: cards.filter((c) => c.rol.toLowerCase().includes("limp")),
		ranking_ventas: { labels: [], values: [] },
	};
}

export async function clientes(
	db: Client,
	range: StatsRange,
): Promise<ClientesStatsResponse> {
	const { start, end } = rangeBounds(range);
	const hasClientes = await tableExists(db, "Clientes");
	if (!hasClientes) {
		return {
			nuevos: 0,
			recurrentes: 0,
			no_recurrentes: 0,
			ticket_medio_cliente: 0,
			nuevos_por_bucket: { labels: [], values: [] },
			top_clientes_gasto: { labels: [], values: [] },
		};
	}
	const dt = "datetime(Created_At)";
	const b = bucket(range, dt);
	const nuevos = await one(
		db,
		`SELECT COUNT(*) AS n FROM Clientes WHERE Created_At IS NOT NULL AND ${dt} >= ${start} AND ${dt} < ${end};`,
	);
	const evoRs = await db.execute(
		`SELECT ${b} AS label, COUNT(*) AS value FROM Clientes
		 WHERE Created_At IS NOT NULL AND ${dt} >= ${start} AND ${dt} < ${end}
		 GROUP BY label ORDER BY label ASC;`,
	);
	const topRs = await db.execute(`
		SELECT COALESCE(NULLIF(trim(Nombre),''),'Cliente') || ' #' || ID_Cliente AS label, ROUND(COALESCE(Total_Gastado,0),2) AS value
		FROM Clientes
		ORDER BY COALESCE(Total_Gastado,0) DESC, label ASC
		LIMIT 10;
	`);
	const evo = rows(evoRs);
	const top = rows(topRs);
	return {
		nuevos: num(nuevos.n),
		recurrentes: 0,
		no_recurrentes: num(nuevos.n),
		ticket_medio_cliente: 0,
		nuevos_por_bucket: { labels: evo.map((r) => String(r.label ?? "")), values: evo.map((r) => num(r.value)) },
		top_clientes_gasto: { labels: top.map((r) => String(r.label ?? "")), values: top.map((r) => num(r.value)) },
	};
}

export async function proveedores(
	db: Client,
	range: StatsRange,
): Promise<ProveedoresStatsResponse> {
	if (!(await tableExists(db, "Cuentas_Gastos"))) {
		return {
			total_gasto: 0,
			num_gastos: 0,
			gasto_medio: 0,
			porcentaje_sobre_total_gastos: 0,
			proveedor_top: null,
			gastos_evolucion: { labels: [], values: [] },
			gasto_por_proveedor: { labels: [], values: [] },
			ultimos_gastos: [],
		};
	}
	const { start, end } = rangeBounds(range);
	const dt = "CASE WHEN cg.Fecha LIKE '%:%' THEN datetime(cg.Fecha) ELSE datetime(cg.Fecha || ' 00:00:00') END";
	const b = bucket(range, dt);
	const filter = "AND (cg.ID_Proveedor IS NOT NULL OR lower(COALESCE(cg.Tipo_Gasto,'')) LIKE '%proveedor%')";
	const total = await one(
		db,
		`SELECT ROUND(COALESCE(SUM(cg.Importe),0),2) AS total, COUNT(*) AS n
		 FROM Cuentas_Gastos cg
		 WHERE cg.Fecha IS NOT NULL AND ${dt} >= ${start} AND ${dt} < ${end} ${filter};`,
	);
	const top = await one(
		db,
		`SELECT COALESCE(NULLIF(trim(p.Nombre_Empresa),''),'Sin proveedor') AS nombre, ROUND(SUM(cg.Importe),2) AS total
		 FROM Cuentas_Gastos cg
		 LEFT JOIN Proveedores p ON p.ID_Proveedor = cg.ID_Proveedor
		 WHERE cg.Fecha IS NOT NULL AND ${dt} >= ${start} AND ${dt} < ${end} ${filter}
		 GROUP BY nombre ORDER BY total DESC LIMIT 1;`,
	);
	const evoRs = await db.execute(
		`SELECT ${b} AS label, ROUND(SUM(cg.Importe),2) AS value
		 FROM Cuentas_Gastos cg
		 WHERE cg.Fecha IS NOT NULL AND ${dt} >= ${start} AND ${dt} < ${end} ${filter}
		 GROUP BY label ORDER BY label ASC;`,
	);
	const barRs = await db.execute(
		`SELECT COALESCE(NULLIF(trim(p.Nombre_Empresa),''),'Sin proveedor') AS label, ROUND(SUM(cg.Importe),2) AS value
		 FROM Cuentas_Gastos cg
		 LEFT JOIN Proveedores p ON p.ID_Proveedor = cg.ID_Proveedor
		 WHERE cg.Fecha IS NOT NULL AND ${dt} >= ${start} AND ${dt} < ${end} ${filter}
		 GROUP BY label ORDER BY value DESC LIMIT 12;`,
	);
	const lastRs = await db.execute(
		`SELECT strftime('%Y-%m-%d', ${dt}) AS fecha, COALESCE(NULLIF(trim(p.Nombre_Empresa),''),'Sin proveedor') AS proveedor, COALESCE(cg.Concepto,'') AS concepto, ROUND(cg.Importe,2) AS importe
		 FROM Cuentas_Gastos cg
		 LEFT JOIN Proveedores p ON p.ID_Proveedor = cg.ID_Proveedor
		 WHERE cg.Fecha IS NOT NULL AND ${dt} >= ${start} AND ${dt} < ${end} ${filter}
		 ORDER BY ${dt} DESC LIMIT 10;`,
	);
	const evo = rows(evoRs);
	const bar = rows(barRs);
	const last = rows(lastRs);
	return {
		total_gasto: num(total.total),
		num_gastos: num(total.n),
		gasto_medio: num(total.n) > 0 ? Math.round((num(total.total) / num(total.n)) * 100) / 100 : 0,
		porcentaje_sobre_total_gastos: 0,
		proveedor_top: top.nombre ? { nombre: String(top.nombre), total: num(top.total) } : null,
		gastos_evolucion: { labels: evo.map((r) => String(r.label ?? "")), values: evo.map((r) => num(r.value)) },
		gasto_por_proveedor: { labels: bar.map((r) => String(r.label ?? "")), values: bar.map((r) => num(r.value)) },
		ultimos_gastos: last.map((r) => ({
			fecha: String(r.fecha ?? ""),
			proveedor: String(r.proveedor ?? ""),
			concepto: String(r.concepto ?? ""),
			importe: num(r.importe),
		})),
	};
}
