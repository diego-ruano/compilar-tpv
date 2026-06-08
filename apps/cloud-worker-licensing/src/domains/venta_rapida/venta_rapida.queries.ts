// src/domains/venta_rapida/venta_rapida.queries.ts

import type { Client } from "@libsql/client/web";

import type {
	CategoriaRow,
	ComandaBarraRow,
	IndexRow,
	LineaComandaRow,
	ProductoRow,
	VerTicketsDetalleRow,
} from "@tpv/contracts";

import type {
	CobrarFraccionadoInput,
	RestarStockInput,
} from "./venta_rapida.schemas";

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

const PENDING_EXPR = `
	CASE
		WHEN (
			COALESCE(c.Total_Comanda,0)
			- COALESCE((SELECT SUM(p.Importe_Total) FROM Pagos p WHERE p.ID_Comanda = c.ID_Comanda), 0)
		) < 0 THEN 0
		ELSE (
			COALESCE(c.Total_Comanda,0)
			- COALESCE((SELECT SUM(p.Importe_Total) FROM Pagos p WHERE p.ID_Comanda = c.ID_Comanda), 0)
		)
	END
`;

export async function categorias(db: Client): Promise<CategoriaRow[]> {
	const rs = await db.execute(`
		SELECT
			ID_Categoria AS ID_Categoria,
			Nombre AS Nombre,
			Nombre_Imagen AS Nombre_Imagen,
			Ruta_Imagen AS Ruta_Imagen,
			Vendible AS Vendible
		FROM Categorias_Producto
		WHERE COALESCE(Vendible,1) = 1
		ORDER BY Nombre ASC;
	`);
	return rows(rs) as CategoriaRow[];
}

function productosSql(where: string, suffix = "") {
	return `
		SELECT
			p.ID_Producto AS ID_Producto,
			p.ID_Categoria AS ID_Categoria,
			p.Nombre AS Nombre,
			COALESCE(p.Precio_Venta,0) AS Precio_Venta,
			COALESCE(v.Stock_Actual,0) AS Stock_Actual,
			COALESCE(p.Stock_Minimo,0) AS Stock_Minimo,
			p.Unidad_Medida AS Unidad_Medida,
			p.Nombre_Imagen AS Nombre_Imagen,
			p.Ruta_Imagen AS Ruta_Imagen
		FROM Productos p
		JOIN Categorias_Producto c ON c.ID_Categoria = p.ID_Categoria
		LEFT JOIN v_inventario_producto_stock v ON v.ID_Producto = p.ID_Producto
		WHERE ${where}
			AND COALESCE(c.Vendible,1) = 1
		ORDER BY p.Nombre ASC
		${suffix};
	`;
}

export async function productosByCategoria(
	db: Client,
	idCategoria: number,
): Promise<ProductoRow[]> {
	const rs = await db.execute({
		sql: productosSql("p.ID_Categoria = ?1"),
		args: [idCategoria],
	});
	return rows(rs) as ProductoRow[];
}

export async function searchProductos(
	db: Client,
	query: string,
	limit: number,
): Promise<ProductoRow[]> {
	if (!query.trim()) return [];
	const rs = await db.execute({
		sql: productosSql("p.Nombre LIKE ?1", "LIMIT ?2"),
		args: [`%${query}%`, limit],
	});
	return rows(rs) as ProductoRow[];
}

export async function barraMesaId(db: Client): Promise<number> {
	const rs = await db.execute(`
		SELECT ID_Mesa AS id
		FROM Mesas
		WHERE Numero_Mesa = 'BARRA'
		ORDER BY ID_Mesa ASC
		LIMIT 1;
	`);
	return Number(rows(rs)[0]?.id ?? 0);
}

export async function openBarraComanda(
	db: Client,
	idMesaBarra: number,
): Promise<number> {
	if (idMesaBarra <= 0) return 0;
	const rs = await db.execute({
		sql: `
			SELECT ID_Comanda AS id
			FROM Comandas
			WHERE ID_Mesa = ?1
				AND Estado = 'Abierta'
			ORDER BY ID_Comanda DESC
			LIMIT 1;
		`,
		args: [idMesaBarra],
	});
	return Number(rows(rs)[0]?.id ?? 0);
}

export async function resolveTrabajadorId(
	db: Client,
	idMaybe: number | null,
): Promise<number | null> {
	if (!idMaybe || idMaybe <= 0) return null;
	const rs = await db.execute({
		sql: `
			SELECT COALESCE(
				(SELECT ID_Trabajador FROM Trabajadores WHERE ID_Trabajador = ?1 LIMIT 1),
				(SELECT ID_Trabajador FROM Trabajadores WHERE ID_Usuario = ?1 LIMIT 1)
			) AS id;
		`,
		args: [idMaybe],
	});
	const id = Number(rows(rs)[0]?.id ?? 0);
	return id > 0 ? id : null;
}

export async function listComandas(
	db: Client,
	includePagadas: boolean,
	limit: number,
): Promise<ComandaBarraRow[]> {
	const idMesaBarra = await barraMesaId(db);
	if (idMesaBarra <= 0) return [];
	const whereClause = includePagadas
		? "EXISTS (SELECT 1 FROM Detalle_Comanda dc WHERE dc.ID_Comanda = c.ID_Comanda)"
		: `(${PENDING_EXPR}) > 0
			AND EXISTS (SELECT 1 FROM Detalle_Comanda dc WHERE dc.ID_Comanda = c.ID_Comanda)`;
	const rs = await db.execute({
		sql: `
			SELECT
				c.ID_Comanda AS ID_Comanda,
				c.Fecha_Hora_Apertura AS Fecha_Hora_Apertura,
				c.Estado AS Estado,
				ROUND(${PENDING_EXPR}, 2) AS Total_Pendiente,
				ROUND(COALESCE(c.Total_Comanda,0), 2) AS Total_Comanda,
				COALESCE((
					SELECT COUNT(*)
					FROM Detalle_Comanda dc
					LEFT JOIN Productos pr ON pr.ID_Producto = dc.ID_Producto
					LEFT JOIN Categorias_Producto cat ON cat.ID_Categoria = pr.ID_Categoria
					WHERE dc.ID_Comanda = c.ID_Comanda
						AND COALESCE(cat.Pasa_Cocina,0) = 1
						AND COALESCE(dc.Estado_Cocina,'PENDIENTE') <> 'PREPARADO'
				),0) AS Pendientes_Cocina,
				COALESCE((
					SELECT COUNT(*)
					FROM Detalle_Comanda dc
					WHERE dc.ID_Comanda = c.ID_Comanda
						AND NOT EXISTS (SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = dc.ID_Detalle)
				),0) AS Pendientes_Pago
			FROM Comandas c
			WHERE c.ID_Mesa = ?2
				AND (${whereClause})
			ORDER BY c.ID_Comanda DESC
			LIMIT ?1;
		`,
		args: [limit, idMesaBarra],
	});
	return rows(rs) as ComandaBarraRow[];
}

export async function lineas(
	db: Client,
	idComanda: number,
): Promise<LineaComandaRow[]> {
	const rs = await db.execute({
		sql: `
			SELECT
				dc.ID_Detalle AS ID_Detalle,
				dc.ID_Comanda AS ID_Comanda,
				dc.ID_Producto AS ID_Producto,
				COALESCE(dc.Cantidad,1) AS Cantidad,
				COALESCE(dc.Precio_Unitario,0) AS Precio_Unitario,
				dc.Notas AS Notas,
				dc.Estado_Cocina AS Estado_Cocina,
				CASE WHEN EXISTS (
					SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = dc.ID_Detalle
				) THEN 1 ELSE 0 END AS Pagado,
				COALESCE(p.Nombre, 'Producto') AS Nombre
			FROM Detalle_Comanda dc
			LEFT JOIN Productos p ON p.ID_Producto = dc.ID_Producto
			WHERE dc.ID_Comanda = ?1
			ORDER BY dc.ID_Detalle ASC;
		`,
		args: [idComanda],
	});
	return rows(rs) as LineaComandaRow[];
}

export async function indexRows(db: Client, ids: number[]): Promise<IndexRow[]> {
	if (!ids.length) return [];
	const placeholders = ids.map((_, i) => `?${i + 1}`).join(",");
	const rs = await db.execute({
		sql: `
			SELECT
				x.ID_Comanda AS ID_Comanda,
				(
					SELECT GROUP_CONCAT(nn.Nombre, ' - ')
					FROM (
						SELECT DISTINCT COALESCE(p2.Nombre,'') AS Nombre
						FROM Detalle_Comanda dc2
						LEFT JOIN Productos p2 ON p2.ID_Producto = dc2.ID_Producto
						WHERE dc2.ID_Comanda = x.ID_Comanda
						ORDER BY COALESCE(p2.Nombre,'')
					) nn
					WHERE nn.Nombre <> ''
				) AS Productos,
				x.NumLineas AS NumLineas,
				x.Unidades AS Unidades
			FROM (
				SELECT
					dc.ID_Comanda AS ID_Comanda,
					COUNT(*) AS NumLineas,
					COALESCE(SUM(COALESCE(dc.Cantidad,1)),0) AS Unidades
				FROM Detalle_Comanda dc
				WHERE dc.ID_Comanda IN (${placeholders})
				GROUP BY dc.ID_Comanda
			) x;
		`,
		args: ids,
	});
	return rows(rs) as IndexRow[];
}

export async function detallesVerTicket(
	db: Client,
	idComanda: number,
): Promise<VerTicketsDetalleRow[]> {
	const rs = await db.execute({
		sql: `
			SELECT
				dc.ID_Detalle AS ID_Detalle,
				dc.ID_Producto AS ID_Producto,
				COALESCE(p.Nombre,'Producto') AS Nombre,
				COALESCE(dc.Cantidad,1) AS Cantidad,
				COALESCE(dc.Precio_Unitario,0) AS Precio_Unitario,
				COALESCE(dc.Estado_Cocina,'PENDIENTE') AS Estado_Cocina,
				CASE WHEN EXISTS (
					SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = dc.ID_Detalle
				) THEN 1 ELSE 0 END AS Pagado,
				dc.Notas AS Notas
			FROM Detalle_Comanda dc
			LEFT JOIN Productos p ON p.ID_Producto = dc.ID_Producto
			WHERE dc.ID_Comanda = ?1
			ORDER BY dc.ID_Detalle ASC;
		`,
		args: [idComanda],
	});
	return rows(rs) as VerTicketsDetalleRow[];
}

export type StockAllocation = {
	id_lote: number;
	take: number;
	id_detalle?: number;
};

export type CobroPlan =
	| {
			ok: true;
			id_pago: number;
			importe_total: number;
			id_usuario_cobrador: number | null;
			id_trabajador_cobrador: number | null;
			allocations: StockAllocation[];
		}
	| {
			ok: false;
			error: string;
			productoId?: number;
			requested?: number;
			available?: number;
		};

export async function nextId(
	db: Client,
	table: string,
	column: string,
): Promise<number> {
	const rs = await db.execute(`SELECT COALESCE(MAX(${column}), 0) + 1 AS id FROM ${table};`);
	return Math.max(1, Number(rows(rs)[0]?.id ?? 1));
}

async function lotRows(db: Client, productoId: number) {
	const rs = await db.execute({
		sql: `
			SELECT
				ID_Lote AS id_lote,
				COALESCE(Stock_Disponible,0) AS stock
			FROM Lotes_Producto
			WHERE ID_Producto = ?1
				AND COALESCE(Stock_Disponible,0) > 0
			ORDER BY
				CASE WHEN Caducidad IS NULL THEN 1 ELSE 0 END,
				date(Caducidad) ASC,
				datetime(Fecha_Entrada) ASC,
				ID_Lote ASC;
		`,
		args: [productoId],
	});
	return rows(rs).map((r) => ({
		id_lote: Number(r.id_lote ?? 0),
		stock: Number(r.stock ?? 0),
	}));
}

export async function cobrarPlan(
	db: Client,
	input: CobrarFraccionadoInput,
): Promise<CobroPlan> {
	const placeholders = input.detalles.map((_, i) => `?${i + 2}`).join(",");
	const detalleArgs = [input.id_comanda, ...input.detalles];

	const resumenRs = await db.execute({
		sql: `
			SELECT
				IFNULL(SUM(COALESCE(dc.Cantidad,1) * COALESCE(dc.Precio_Unitario,0)), 0) AS importe,
				COUNT(*) AS num_valid
			FROM Detalle_Comanda dc
			WHERE dc.ID_Comanda = ?1
				AND dc.ID_Detalle IN (${placeholders})
				AND NOT EXISTS (
					SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = dc.ID_Detalle
				);
		`,
		args: detalleArgs,
	});
	const resumen = rows(resumenRs)[0] ?? {};
	if (Number(resumen.num_valid ?? 0) <= 0) {
		return { ok: false, error: "no_valid_pending_details" };
	}

	const chargedRs = await db.execute({
		sql: `
			SELECT
				dc.ID_Detalle AS id_detalle,
				dc.ID_Producto AS id_producto,
				CAST(COALESCE(dc.Cantidad,1) AS REAL) AS cantidad
			FROM Detalle_Comanda dc
			WHERE dc.ID_Comanda = ?1
				AND dc.ID_Detalle IN (${placeholders})
				AND NOT EXISTS (
					SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = dc.ID_Detalle
				)
			ORDER BY dc.ID_Detalle;
		`,
		args: detalleArgs,
	});
	const charged = rows(chargedRs)
		.map((r) => ({
			id_detalle: Number(r.id_detalle ?? 0),
			id_producto: Number(r.id_producto ?? 0),
			cantidad: Number(r.cantidad ?? 0),
		}))
		.filter((r) => r.id_detalle > 0 && r.id_producto > 0 && r.cantidad > 0);

	const requestedByProduct = new Map<number, number>();
	for (const c of charged) {
		requestedByProduct.set(
			c.id_producto,
			(requestedByProduct.get(c.id_producto) ?? 0) + c.cantidad,
		);
	}

	for (const [productoId, requested] of requestedByProduct) {
		const lots = await lotRows(db, productoId);
		const available = lots.reduce((acc, l) => acc + l.stock, 0);
		if (lots.length > 0 && requested > available) {
			return {
				ok: false,
				error: "insufficient_stock",
				productoId,
				requested,
				available,
			};
		}
	}

	const allocations: StockAllocation[] = [];
	for (const c of charged) {
		let remaining = c.cantidad;
		for (const lot of await lotRows(db, c.id_producto)) {
			if (remaining <= 0) break;
			const take = Math.min(remaining, lot.stock);
			if (take <= 0) continue;
			allocations.push({
				id_lote: lot.id_lote,
				take,
				id_detalle: c.id_detalle,
			});
			remaining -= take;
		}
	}

	const idUsuario = input.id_usuario_cobrador;
	const idTrabFromUser = await resolveTrabajadorId(db, idUsuario);
	const comandaRs = await db.execute({
		sql: "SELECT ID_Trabajador AS id FROM Comandas WHERE ID_Comanda = ?1 LIMIT 1;",
		args: [input.id_comanda],
	});
	const idTrabComanda = Number(rows(comandaRs)[0]?.id ?? 0) || null;

	return {
		ok: true,
		id_pago: await nextId(db, "Pagos", "ID_Pago"),
		importe_total: Number(resumen.importe ?? 0),
		id_usuario_cobrador: idUsuario,
		id_trabajador_cobrador:
			input.id_trabajador_cobrador ?? idTrabFromUser ?? idTrabComanda,
		allocations,
	};
}

export type RestarStockPlan =
	| { ok: true; allocations: StockAllocation[] }
	| {
			ok: false;
			error: string;
			productoId?: number;
			requested?: number;
			available?: number;
		};

export async function restarStockPlan(
	db: Client,
	input: RestarStockInput,
): Promise<RestarStockPlan> {
	for (const it of input.lineas) {
		const lots = await lotRows(db, it.producto_id);
		const available = lots.reduce((acc, l) => acc + l.stock, 0);
		if (lots.length > 0 && it.cantidad > available) {
			return {
				ok: false,
				error: "insufficient_stock",
				productoId: it.producto_id,
				requested: it.cantidad,
				available,
			};
		}
	}

	const allocations: StockAllocation[] = [];
	for (const it of input.lineas) {
		let remaining = it.cantidad;
		for (const lot of await lotRows(db, it.producto_id)) {
			if (remaining <= 0) break;
			const take = Math.min(remaining, lot.stock);
			if (take <= 0) continue;
			allocations.push({ id_lote: lot.id_lote, take });
			remaining -= take;
		}
	}
	return { ok: true, allocations };
}

export async function hasPaidLines(db: Client, idComanda: number): Promise<boolean> {
	const rs = await db.execute({
		sql: `
			SELECT EXISTS(
				SELECT 1
				FROM Detalle_Comanda dc
				JOIN Pago_Detalles pd ON pd.ID_Detalle = dc.ID_Detalle
				WHERE dc.ID_Comanda = ?1
			) AS has_paid;
		`,
		args: [idComanda],
	});
	return Number(rows(rs)[0]?.has_paid ?? 0) === 1;
}
