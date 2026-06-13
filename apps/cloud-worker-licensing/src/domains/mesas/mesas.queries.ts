// src/domains/mesas/mesas.queries.ts

import type { Client } from "@libsql/client/web";

import type {
	CategoriaVendibleOut,
	ComandaRow,
	KitchenRow,
	MesaLineaComandaRow,
	MesaMetaOut,
	ProductoVendibleOut,
	SalonOut,
} from "@tpv/contracts";

import type { CobrarDetallesInput } from "./mesas.schemas";

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

function parsePoints(raw: any): number[] {
	try {
		const v = JSON.parse(String(raw ?? "[]"));
		return Array.isArray(v) ? v.map(Number).filter(Number.isFinite) : [];
	} catch {
		return [];
	}
}

export async function resolveTrabajadorId(
	db: Client,
	idMaybe: string | null,
): Promise<string | null> {
	if (!idMaybe || !idMaybe.trim()) return null;
	const rs = await db.execute({
		sql: `
			SELECT COALESCE(
				(SELECT ID_Trabajador FROM Trabajadores WHERE ID_Trabajador = ?1 LIMIT 1),
				(SELECT ID_Trabajador FROM Trabajadores WHERE ID_Usuario = ?1 LIMIT 1)
			) AS id;
		`,
		args: [idMaybe],
	});
	const id = String(rows(rs)[0]?.id ?? "").trim();
	return id ? id : null;
}

export async function loadLayout(db: Client): Promise<SalonOut[]> {
	const zonasRs = await db.execute(`
		SELECT ID_Zona, Nombre_Zona, Room_Points
		FROM Zonas
		ORDER BY ID_Zona ASC;
	`);
	const mesasRs = await db.execute(`
		SELECT
			ID_Mesa,
			ID_Zona,
			Numero_Mesa,
			Capacidad,
			Ubicacion_X,
			Ubicacion_Y,
			Shape,
			Width,
			Height,
			Radius
		FROM Mesas
		WHERE Es_Sistema = 0
		ORDER BY ID_Zona ASC, ID_Mesa ASC;
	`);

	const byZona = new Map<number, any[]>();
	for (const m of rows(mesasRs)) {
		const idZona = Number(m.ID_Zona ?? 0);
		const idMesa = Number(m.ID_Mesa ?? 0);
		if (idZona <= 0 || idMesa <= 0) continue;
		const list = byZona.get(idZona) ?? [];
		list.push({
			id: `db-mesa-${idMesa}`,
			name: String(m.Numero_Mesa ?? `Mesa ${idMesa}`),
			x: Number(m.Ubicacion_X ?? 0),
			y: Number(m.Ubicacion_Y ?? 0),
			width: Number(m.Width ?? 120),
			height: Number(m.Height ?? 70),
			radius: m.Radius == null ? null : Number(m.Radius),
			seats: Number(m.Capacidad ?? 4),
			shape: String(m.Shape ?? "rounded"),
		});
		byZona.set(idZona, list);
	}

	return rows(zonasRs).map((z) => {
		const idZona = Number(z.ID_Zona ?? 0);
		return {
			id: `db-zona-${idZona}`,
			name: String(z.Nombre_Zona ?? `Zona ${idZona}`),
			room: { type: "poly", points: parsePoints(z.Room_Points) },
			tables: byZona.get(idZona) ?? [],
		} as SalonOut;
	});
}

export async function mesasOcupadas(db: Client): Promise<Record<string, boolean>> {
	const rs = await db.execute(`
		SELECT M.ID_Zona, C.ID_Mesa
		FROM Comandas C
		JOIN Mesas M ON M.ID_Mesa = C.ID_Mesa
		WHERE C.Estado = 'Abierta';
	`);
	const out: Record<string, boolean> = {};
	for (const r of rows(rs)) {
		const idZona = Number(r.ID_Zona ?? 0);
		const idMesa = Number(r.ID_Mesa ?? 0);
		out[`z${idZona}:m${idMesa}`] = true;
		out[`db-mesa-${idMesa}`] = true;
		out[String(idMesa)] = true;
	}
	return out;
}

export async function readComanda(
	db: Client,
	idComanda: string,
): Promise<ComandaRow | null> {
	const rs = await db.execute({
		sql: `
			SELECT
				ID_Comanda AS id_comanda,
				ID_Mesa AS id_mesa,
				ID_Trabajador AS id_trabajador,
				ID_Reserva AS id_reserva,
				Fecha_Hora_Apertura AS fecha_hora_apertura,
				Fecha_Hora_Cierre AS fecha_hora_cierre,
				COALESCE(Total_Comanda,0) AS total_comanda,
				COALESCE(Estado,'Abierta') AS estado
			FROM Comandas
			WHERE ID_Comanda = ?1
			LIMIT 1;
		`,
		args: [idComanda],
	});
	return (rows(rs)[0] ?? null) as ComandaRow | null;
}

export async function comandaAbiertaByMesa(
	db: Client,
	idMesa: string,
): Promise<ComandaRow | null> {
	const rs = await db.execute({
		sql: `
			SELECT ID_Comanda AS id
			FROM Comandas
			WHERE ID_Mesa = ?1 AND Estado = 'Abierta'
			ORDER BY ID_Comanda DESC
			LIMIT 1;
		`,
		args: [idMesa],
	});
	const id = String(rows(rs)[0]?.id ?? "").trim();
	return id ? readComanda(db, id) : null;
}

export async function activeReservaForMesa(
	db: Client,
	idMesa: string,
): Promise<string | null> {
	const rs = await db.execute({
		sql: `
			SELECT ID_Reserva AS id
			FROM Reservas
			WHERE ID_Mesa = ?1 AND Estado = 'ACTIVA'
			ORDER BY ID_Reserva DESC
			LIMIT 1;
		`,
		args: [idMesa],
	});
	const id = String(rows(rs)[0]?.id ?? "").trim();
	return id ? id : null;
}

export async function lineas(
	db: Client,
	idComanda: string,
): Promise<MesaLineaComandaRow[]> {
	const rs = await db.execute({
		sql: `
			SELECT
				D.ID_Detalle AS ID_Detalle,
				D.ID_Comanda AS ID_Comanda,
				D.ID_Producto AS ID_Producto,
				COALESCE(D.Cantidad, 1) AS Cantidad,
				COALESCE(D.Precio_Unitario, 0) AS Precio_Unitario,
				D.Notas AS Notas,
				D.Estado_Cocina AS Estado_Cocina,
				P.Nombre AS Nombre,
				COALESCE(cat.Pasa_Cocina, 0) AS Pasa_Cocina,
				CASE WHEN EXISTS (
					SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = D.ID_Detalle
				) THEN 1 ELSE 0 END AS Pagado
			FROM Detalle_Comanda D
			JOIN Productos P ON P.ID_Producto = D.ID_Producto
			JOIN Categorias_Producto cat ON cat.ID_Categoria = P.ID_Categoria
			WHERE D.ID_Comanda = ?1
			ORDER BY D.ID_Detalle ASC;
		`,
		args: [idComanda],
	});
	return rows(rs) as MesaLineaComandaRow[];
}

export async function mesasMetaAll(db: Client): Promise<Record<string, MesaMetaOut>> {
	const rs = await db.execute(`
		SELECT
			c.ID_Mesa AS id_mesa,
			c.ID_Comanda AS id_comanda,
			(
				SELECT IFNULL(SUM(dc.Precio_Unitario * COALESCE(dc.Cantidad,1)), 0)
				FROM Detalle_Comanda dc
				LEFT JOIN Pago_Detalles pd ON pd.ID_Detalle = dc.ID_Detalle
				WHERE dc.ID_Comanda = c.ID_Comanda AND pd.ID_Detalle IS NULL
			) AS total_pendiente,
			(
				SELECT COUNT(*)
				FROM Detalle_Comanda dc
				LEFT JOIN Pago_Detalles pd ON pd.ID_Detalle = dc.ID_Detalle
				WHERE dc.ID_Comanda = c.ID_Comanda AND pd.ID_Detalle IS NULL
			) AS pendientes_pago,
			(
				SELECT COUNT(*)
				FROM Detalle_Comanda dc
				JOIN Productos p ON p.ID_Producto = dc.ID_Producto
				JOIN Categorias_Producto cat ON cat.ID_Categoria = p.ID_Categoria
				LEFT JOIN Pago_Detalles pd ON pd.ID_Detalle = dc.ID_Detalle
				WHERE dc.ID_Comanda = c.ID_Comanda
					AND pd.ID_Detalle IS NULL
					AND COALESCE(cat.Pasa_Cocina, 0) = 1
					AND COALESCE(dc.Estado_Cocina,'PENDIENTE') <> 'PREPARADO'
			) AS pendientes_cocina
		FROM Comandas c
		WHERE c.Estado = 'Abierta';
	`);
	const out: Record<string, MesaMetaOut> = {};
	for (const r of rows(rs)) {
		const idMesa = String(r.id_mesa ?? "");
		const idComanda = String(r.id_comanda ?? "");
		const totalPendiente = Number(r.total_pendiente ?? 0);
		const pendientesPago = Number(r.pendientes_pago ?? 0);
		const meta: MesaMetaOut = {
			ocupada: true,
			id_comanda: idComanda,
			idComanda,
			totalPendiente,
			pendientesPago,
			pendientesCocina: Number(r.pendientes_cocina ?? 0),
			estado: pendientesPago > 0 || totalPendiente > 0 ? "PENDIENTE" : "LIBRE",
		};
		out[String(idMesa)] = meta;
	}
	return out;
}

export async function categorias(db: Client): Promise<CategoriaVendibleOut[]> {
	const rs = await db.execute(`
		SELECT
			ID_Categoria AS ID_Categoria,
			Nombre AS Nombre,
			Ruta_Imagen AS Ruta_Imagen,
			COALESCE(Pasa_Cocina,0) AS Pasa_Cocina
		FROM Categorias_Producto
		ORDER BY Nombre ASC;
	`);
	return rows(rs) as CategoriaVendibleOut[];
}

export async function productosByCategoria(
	db: Client,
	idCategoria: string,
): Promise<ProductoVendibleOut[]> {
	const rs = await db.execute({
		sql: `
			SELECT
				ID_Producto AS ID_Producto,
				ID_Categoria AS ID_Categoria,
				Nombre AS Nombre,
				COALESCE(Precio_Venta,0) AS Precio_Venta,
				Ruta_Imagen AS Ruta_Imagen
			FROM Productos
			WHERE ID_Categoria = ?1
			ORDER BY Nombre ASC;
		`,
		args: [idCategoria],
	});
	return rows(rs) as ProductoVendibleOut[];
}

export async function searchProductos(
	db: Client,
	query: string,
): Promise<ProductoVendibleOut[]> {
	if (!query.trim()) return [];
	const rs = await db.execute({
		sql: `
			SELECT
				ID_Producto AS ID_Producto,
				ID_Categoria AS ID_Categoria,
				Nombre AS Nombre,
				COALESCE(Precio_Venta,0) AS Precio_Venta,
				Ruta_Imagen AS Ruta_Imagen
			FROM Productos
			WHERE LOWER(Nombre) LIKE ?1
			ORDER BY Nombre ASC
			LIMIT 200;
		`,
		args: [`%${query.toLowerCase()}%`],
	});
	return rows(rs) as ProductoVendibleOut[];
}

export async function productoPasaCocina(
	db: Client,
	idProducto: string,
): Promise<boolean> {
	const rs = await db.execute({
		sql: `
			SELECT COALESCE(cat.Pasa_Cocina, 0) AS pasa
			FROM Productos p
			JOIN Categorias_Producto cat ON cat.ID_Categoria = p.ID_Categoria
			WHERE p.ID_Producto = ?1
			LIMIT 1;
		`,
		args: [idProducto],
	});
	return Number(rows(rs)[0]?.pasa ?? 0) === 1;
}

export async function idComandaByDetalle(
	db: Client,
	idDetalle: string,
): Promise<string | null> {
	const rs = await db.execute({
		sql: `
			SELECT ID_Comanda AS id
			FROM Detalle_Comanda
			WHERE ID_Detalle = ?1
			LIMIT 1;
		`,
		args: [idDetalle],
	});
	const id = String(rows(rs)[0]?.id ?? "").trim();
	return id ? id : null;
}

export type CobroDetallesPlan =
	| { ok: true; total: number; id_trabajador: string | null }
	| { ok: false; error: string };

export async function cobrarDetallesPlan(
	db: Client,
	input: CobrarDetallesInput,
): Promise<CobroDetallesPlan> {
	const placeholders = input.detalle_ids.map((_, i) => `?${i + 2}`).join(",");
	const args = [input.id_comanda, ...input.detalle_ids];
	const countRs = await db.execute({
		sql: `
			SELECT COUNT(*) AS n
			FROM Detalle_Comanda dc
			WHERE dc.ID_Comanda = ?1
				AND dc.ID_Detalle IN (${placeholders})
				AND NOT EXISTS (
					SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = dc.ID_Detalle
				);
		`,
		args,
	});
	if (Number(rows(countRs)[0]?.n ?? 0) !== input.detalle_ids.length) {
		return { ok: false, error: "invalid_or_paid_details" };
	}
	const totalRs = await db.execute({
		sql: `
			SELECT IFNULL(SUM(COALESCE(dc.Cantidad,1) * COALESCE(dc.Precio_Unitario,0)), 0) AS total
			FROM Detalle_Comanda dc
			WHERE dc.ID_Comanda = ?1
				AND dc.ID_Detalle IN (${placeholders})
				AND NOT EXISTS (
					SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = dc.ID_Detalle
				);
		`,
		args,
	});
	const total = Math.round(Number(rows(totalRs)[0]?.total ?? 0) * 100) / 100;
	return {
		ok: true,
		total,
		id_trabajador: await resolveTrabajadorId(db, input.id_usuario),
	};
}

export async function kitchenList(db: Client): Promise<KitchenRow[]> {
	const rs = await db.execute(`
		SELECT
			c.ID_Comanda AS ID_Comanda,
			m.Numero_Mesa AS Numero_Mesa,
			c.Fecha_Hora_Apertura AS Fecha_Hora_Apertura,
			dc.ID_Detalle AS ID_Detalle,
			COALESCE(dc.Cantidad,1) AS Cantidad,
			p.Nombre AS Nombre_Producto,
			dc.Notas AS Notas,
			COALESCE(dc.Estado_Cocina,'PENDIENTE') AS Estado_Cocina,
			CASE WHEN EXISTS (
				SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = dc.ID_Detalle
			) THEN 1 ELSE 0 END AS Pagado
		FROM Detalle_Comanda dc
		JOIN Comandas c ON c.ID_Comanda = dc.ID_Comanda
		JOIN Mesas m ON m.ID_Mesa = c.ID_Mesa
		JOIN Productos p ON p.ID_Producto = dc.ID_Producto
		JOIN Categorias_Producto cat ON cat.ID_Categoria = p.ID_Categoria
		WHERE COALESCE(cat.Pasa_Cocina, 0) = 1
			AND datetime(c.Fecha_Hora_Apertura,'localtime') >= datetime('now','localtime','-2 days')
			AND EXISTS (
				SELECT 1
				FROM Detalle_Comanda dc2
				JOIN Productos p2 ON p2.ID_Producto = dc2.ID_Producto
				JOIN Categorias_Producto cat2 ON cat2.ID_Categoria = p2.ID_Categoria
				WHERE dc2.ID_Comanda = c.ID_Comanda
					AND COALESCE(cat2.Pasa_Cocina, 0) = 1
					AND COALESCE(dc2.Estado_Cocina,'PENDIENTE') <> 'PREPARADO'
			)
		ORDER BY datetime(c.Fecha_Hora_Apertura) ASC, c.ID_Comanda ASC, dc.ID_Detalle ASC;
	`);
	return rows(rs) as KitchenRow[];
}
