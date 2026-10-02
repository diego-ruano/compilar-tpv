// src/domains/mesas/mesas.queries.ts

import type { Client } from "@libsql/client/web";
import { deLaBase } from "../../lib/dinero";
import { planConsumo, type PlanConsumo } from "../inventario/consumo";

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
		WHERE Archivada_En IS NULL -- RI-54: lo archivado ya no está en el plano
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
		WHERE Archivada_En IS NULL
		ORDER BY ID_Zona ASC, ID_Mesa ASC;
	`);

	const byZona = new Map<string, any[]>();
	for (const m of rows(mesasRs)) {
		const idZona = String(m.ID_Zona ?? "").trim();
		const idMesa = String(m.ID_Mesa ?? "").trim();
		if (!idZona || !idMesa) continue;
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
		const idZona = String(z.ID_Zona ?? "").trim();
		return {
			id: `db-zona-${idZona}`,
			name: String(z.Nombre_Zona ?? `Zona ${idZona}`),
			room: { type: "poly", points: parsePoints(z.Room_Points) },
			tables: byZona.get(idZona) ?? [],
		} as SalonOut;
	});
}

/**
 * Mesas con comanda abierta, indexadas por **el ID de mesa pelado**.
 *
 * Antes salían tres claves por mesa (`db-zona-Z:db-mesa-M`, `db-mesa-M` y el id suelto) para tapar
 * que la Main devolvía sólo la compuesta, que es justo la que `parseAnyMesaId` no sabe leer. Ahora
 * la Main devuelve el id pelado y aquí basta con esa: una sola clave, la misma en los dos lados y
 * la única que los lookups del frontend buscan. La zona sobraba — el ID de mesa ya es único.
 */
export async function mesasOcupadas(db: Client): Promise<Record<string, boolean>> {
	const rs = await db.execute(`
		SELECT C.ID_Mesa
		FROM Comandas C
		JOIN Mesas M ON M.ID_Mesa = C.ID_Mesa
		WHERE C.Estado = 'Abierta';
	`);
	const out: Record<string, boolean> = {};
	for (const r of rows(rs)) {
		const idMesa = String(r.ID_Mesa ?? "").trim();
		if (!idMesa) continue;
		out[idMesa] = true;
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

function stripMesaPrefix(id: string): string {
	const s = String(id || "").trim();
	return s.startsWith("db-mesa-") ? s.slice("db-mesa-".length).trim() : s;
}

export async function comandaAbiertaByMesa(
	db: Client,
	idMesa: string,
): Promise<ComandaRow | null> {
	const bareId = stripMesaPrefix(idMesa);
	if (!bareId) return null;
	const rs = await db.execute({
		sql: `
			SELECT ID_Comanda AS id
			FROM Comandas
			WHERE ID_Mesa = ?1 AND Estado = 'Abierta'
			ORDER BY datetime(Fecha_Hora_Apertura) DESC, ID_Comanda DESC
			LIMIT 1;
		`,
		args: [bareId],
	});
	const id = String(rows(rs)[0]?.id ?? "").trim();
	return id ? readComanda(db, id) : null;
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
				-- Un producto retirado del catalogo deja esta columna a NULL (ON DELETE SET NULL),
				-- pero en el DTO ID_Producto es un String, no un Option: un null aqui hace que la
				-- Handy no pueda deserializar la respuesta y se quede sin PODER ABRIR la comanda
				-- entera por una sola linea huerfana. La Main ya devuelve "" en ese caso.
				COALESCE(D.ID_Producto, '') AS ID_Producto,
				COALESCE(D.Cantidad, 1) AS Cantidad,
				COALESCE(D.Precio_Unitario, 0) AS Precio_Unitario,
				D.Notas AS Notas,
				D.Estado_Cocina AS Estado_Cocina,
				COALESCE(D.Nombre_Producto, P.Nombre, 'Producto') AS Nombre,
				COALESCE(cat.Pasa_Cocina, 0) AS Pasa_Cocina,
				D.IVA_Percent AS IVA_Percent,
				CASE WHEN EXISTS (
					SELECT 1 FROM v_lineas_cobradas pd WHERE pd.ID_Detalle = D.ID_Detalle
				) THEN 1 ELSE 0 END AS Pagado
			FROM Detalle_Comanda D
			LEFT JOIN Productos P ON P.ID_Producto = D.ID_Producto
			LEFT JOIN Categorias_Producto cat ON cat.ID_Categoria = P.ID_Categoria
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
				SELECT IFNULL(SUM(CAST(ROUND(dc.Precio_Unitario * COALESCE(dc.Cantidad,1)) AS INTEGER)), 0)
				FROM Detalle_Comanda dc
				WHERE dc.ID_Comanda = c.ID_Comanda AND NOT EXISTS (SELECT 1 FROM v_lineas_cobradas pd WHERE pd.ID_Detalle = dc.ID_Detalle)
			) AS total_pendiente,
			(
				SELECT COUNT(*)
				FROM Detalle_Comanda dc
				WHERE dc.ID_Comanda = c.ID_Comanda AND NOT EXISTS (SELECT 1 FROM v_lineas_cobradas pd WHERE pd.ID_Detalle = dc.ID_Detalle)
			) AS pendientes_pago,
			(
				SELECT COUNT(*)
				FROM Detalle_Comanda dc
				JOIN Productos p ON p.ID_Producto = dc.ID_Producto
				JOIN Categorias_Producto cat ON cat.ID_Categoria = p.ID_Categoria
				WHERE dc.ID_Comanda = c.ID_Comanda
					AND NOT EXISTS (SELECT 1 FROM v_lineas_cobradas pd WHERE pd.ID_Detalle = dc.ID_Detalle)
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
		const totalPendiente = deLaBase(r.total_pendiente);
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
			WHERE ID_Categoria = ?1 AND Archivado_En IS NULL
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
			WHERE LOWER(Nombre) LIKE ?1 AND Archivado_En IS NULL
			ORDER BY Nombre ASC
			LIMIT 200;
		`,
		args: [`%${query.toLowerCase()}%`],
	});
	return rows(rs) as ProductoVendibleOut[];
}

/**
 * Lo que hay que saber del producto ANTES de insertar su línea: si pasa por cocina y con qué tipo
 * de IVA se vende. Los dos se resuelven aquí y viajan como literales en la sentencia, porque una
 * subconsulta dentro del INSERT la reevaluaría la Main en otro estado y la fila dejaría de ser
 * idéntica en las dos copias.
 *
 * Va en UNA sola lectura: son dos columnas de la misma fila y este camino está en el momento de
 * añadir una línea, que es lo que más se repite en un servicio.
 */
export async function datosDeLinea(
	db: Client,
	idProducto: string,
): Promise<{
	pasaCocina: boolean;
	ivaPercent: number | null;
	nombre: string | null;
	archivado: boolean;
}> {
	const rs = await db.execute({
		sql: `
			SELECT COALESCE(cat.Pasa_Cocina, 0) AS pasa, p.IVA_Percent AS iva, p.Nombre AS nombre,
				p.Archivado_En IS NOT NULL AS archivado
			FROM Productos p
			JOIN Categorias_Producto cat ON cat.ID_Categoria = p.ID_Categoria
			WHERE p.ID_Producto = ?1
			LIMIT 1;
		`,
		args: [idProducto],
	});
	const fila = rows(rs)[0];
	const iva = fila?.iva;
	const nombre = fila?.nombre;
	return {
		pasaCocina: Number(fila?.pasa ?? 0) === 1,
		ivaPercent: iva === null || iva === undefined ? null : Number(iva),
		nombre: nombre === null || nombre === undefined ? null : String(nombre),
		// RI-54: la ruta lo rechaza, igual que `snapshot_del_producto` en la Main.
		archivado: Number(fila?.archivado ?? 0) === 1,
	};
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
	| { ok: true; total: number; id_trabajador: string | null; consumo: PlanConsumo }
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
					SELECT 1 FROM v_lineas_cobradas pd WHERE pd.ID_Detalle = dc.ID_Detalle
				);
		`,
		args,
	});
	if (Number(rows(countRs)[0]?.n ?? 0) !== input.detalle_ids.length) {
		return { ok: false, error: "invalid_or_paid_details" };
	}
	const totalRs = await db.execute({
		sql: `
			SELECT IFNULL(SUM(CAST(ROUND(COALESCE(dc.Cantidad,1) * COALESCE(dc.Precio_Unitario,0)) AS INTEGER)), 0) AS total
			FROM Detalle_Comanda dc
			WHERE dc.ID_Comanda = ?1
				AND dc.ID_Detalle IN (${placeholders})
				AND NOT EXISTS (
					SELECT 1 FROM v_lineas_cobradas pd WHERE pd.ID_Detalle = dc.ID_Detalle
				);
		`,
		args,
	});
	// Ya es un entero de centimos: no hay nada que redondear (ARQ-01).
	const total = deLaBase(rows(totalRs)[0]?.total);

	// MESA-01: consumo FEFO best-effort de las lineas cobradas. Se resuelven las
	// asignaciones a lotes aqui (lado autoritativo) y el command builder las emite
	// como UPDATE/INSERT literales -> deterministas al replicarse a la Main. Best-effort:
	// no aborta el cobro si falta stock (paridad con la Main; decision de negocio).
	const chargedRs = await db.execute({
		sql: `
			SELECT
				dc.ID_Detalle AS id_detalle,
				dc.ID_Producto AS id_producto,
				CAST(COALESCE(dc.Cantidad,1) AS REAL) AS cantidad
			FROM Detalle_Comanda dc
			WHERE dc.ID_Comanda = ?1
				AND dc.ID_Detalle IN (${placeholders})
			ORDER BY dc.ID_Detalle;
		`,
		args,
	});
	const charged = rows(chargedRs)
		.map((r) => ({
			id_detalle: String(r.id_detalle ?? ""),
			id_producto: String(r.id_producto ?? ""),
			cantidad: Number(r.cantidad ?? 0),
		}))
		.filter((r) => r.id_detalle.length > 0 && r.id_producto.length > 0 && r.cantidad > 0);

	const consumo = await planConsumo(db, charged);
	return {
		ok: true,
		total,
		id_trabajador: await resolveTrabajadorId(db, input.id_usuario),
		consumo,
	};
}

// RI-18: se empieza por Comandas (CROSS JOIN fija el orden de las tablas en SQLite) y la fecha se
// compara tal cual, sin datetime(). Asi entra por idx_comandas_apertura y lee solo las comandas de
// los dos ultimos dias; antes recorria todas las lineas de la historia en cada refresco, y el
// tablero se refresca con cada linea que se anade. Mismo cambio que kitchen_list_today_pending.
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
				SELECT 1 FROM v_lineas_cobradas pd WHERE pd.ID_Detalle = dc.ID_Detalle
			) THEN 1 ELSE 0 END AS Pagado
		FROM Comandas c
		CROSS JOIN Detalle_Comanda dc ON dc.ID_Comanda = c.ID_Comanda
		JOIN Mesas m ON m.ID_Mesa = c.ID_Mesa
		JOIN Productos p ON p.ID_Producto = dc.ID_Producto
		JOIN Categorias_Producto cat ON cat.ID_Categoria = p.ID_Categoria
		WHERE COALESCE(cat.Pasa_Cocina, 0) = 1
			AND c.Fecha_Hora_Apertura >= datetime('now','localtime','-2 days')
			AND EXISTS (
				SELECT 1
				FROM Detalle_Comanda dc2
				JOIN Productos p2 ON p2.ID_Producto = dc2.ID_Producto
				JOIN Categorias_Producto cat2 ON cat2.ID_Categoria = p2.ID_Categoria
				WHERE dc2.ID_Comanda = c.ID_Comanda
					AND COALESCE(cat2.Pasa_Cocina, 0) = 1
					AND COALESCE(dc2.Estado_Cocina,'PENDIENTE') <> 'PREPARADO'
			)
		ORDER BY c.Fecha_Hora_Apertura ASC, c.ID_Comanda ASC, dc.ID_Detalle ASC;
	`);
	return rows(rs) as KitchenRow[];
}
