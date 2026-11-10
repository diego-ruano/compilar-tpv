// src/domains/venta_rapida/venta_rapida.queries.ts

import { nuevoId } from "../../lib/ids";
import { recortar } from "../../lib/texto";
import { planConsumo, type PlanConsumo } from "../inventario/consumo";
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
} from "./venta_rapida.schemas";

import { CANAL_BARRA } from "./venta_rapida.commands";

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

// Solo los cobros ACTIVOS descuentan del pendiente (CUENTA-07): si un cobro anulado siguiera
// restando, el ticket pareceria pagado y sus lineas -que han vuelto a estar pendientes- no se
// podrian volver a cobrar.
const PENDING_EXPR = `
	CASE
		WHEN (
			COALESCE(c.Total_Comanda,0)
			- COALESCE((SELECT SUM(p.Importe_Total) FROM Pagos p WHERE p.ID_Comanda = c.ID_Comanda AND COALESCE(p.Estado,'ACTIVO') = 'ACTIVO'), 0)
		) < 0 THEN 0
		ELSE (
			COALESCE(c.Total_Comanda,0)
			- COALESCE((SELECT SUM(p.Importe_Total) FROM Pagos p WHERE p.ID_Comanda = c.ID_Comanda AND COALESCE(p.Estado,'ACTIVO') = 'ACTIVO'), 0)
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
			COALESCE(v.Stock_Actual,0) + COALESCE(p.Stock_Suelto,0) AS Stock_Actual,
			COALESCE(p.Stock_Minimo,0) AS Stock_Minimo,
			p.Unidad_Medida AS Unidad_Medida,
			p.Nombre_Imagen AS Nombre_Imagen,
			p.Ruta_Imagen AS Ruta_Imagen
		FROM Productos p
		JOIN Categorias_Producto c ON c.ID_Categoria = p.ID_Categoria
		LEFT JOIN v_inventario_producto_stock v ON v.ID_Producto = p.ID_Producto
		WHERE ${where}
			AND COALESCE(c.Vendible,1) = 1
			AND p.Archivado_En IS NULL -- RI-54
		ORDER BY p.Nombre ASC
		${suffix};
	`;
}

export async function productosByCategoria(
	db: Client,
	idCategoria: string,
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
	if (!recortar(query)) return [];
	const rs = await db.execute({
		sql: productosSql("p.Nombre LIKE ?1", "LIMIT ?2"),
		args: [`%${query}%`, limit],
	});
	return rows(rs) as ProductoRow[];
}

/**
 * Último ticket de barra abierto (el más reciente). La venta rápida admite VARIOS tickets abiertos
 * a la vez; esto solo resuelve el `get_or_create`, que reengancha con el último.
 *
 * Los tickets de barra se identifican por `Canal='BARRA'` y NO tienen mesa. (Antes se buscaban por
 * la mesa "de sistema" BARRA, que ya no existe: ver la nota de la tabla Comandas en
 * 0001_inicial.sql.) Espejo de `find_open_barra_comanda_id` en tpv-infra-sqlite.
 */
export async function openBarraComanda(db: Client): Promise<string> {
	const rs = await db.execute({
		sql: `
			SELECT ID_Comanda AS id
			FROM Comandas
			WHERE Canal = ?1
				AND Estado = 'Abierta'
			ORDER BY datetime(Fecha_Hora_Apertura) DESC
			LIMIT 1;
		`,
		args: [CANAL_BARRA],
	});
	return String(rows(rs)[0]?.id ?? "");
}

export async function resolveTrabajadorId(
	db: Client,
	idMaybe: string | null,
): Promise<string | null> {
	if (!idMaybe || !recortar(idMaybe)) return null;
	const rs = await db.execute({
		sql: `
			SELECT COALESCE(
				(SELECT ID_Trabajador FROM Trabajadores WHERE ID_Trabajador = ?1 LIMIT 1),
				(SELECT ID_Trabajador FROM Trabajadores WHERE ID_Usuario = ?1 LIMIT 1)
			) AS id;
		`,
		args: [idMaybe],
	});
	const id = recortar(String(rows(rs)[0]?.id ?? ""));
	return id ? id : null;
}

export async function listComandas(
	db: Client,
	includePagadas: boolean,
	limit: number,
): Promise<ComandaBarraRow[]> {
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
				${PENDING_EXPR} AS Total_Pendiente,
				COALESCE(c.Total_Comanda,0) AS Total_Comanda,
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
						AND NOT EXISTS (SELECT 1 FROM v_lineas_cobradas pd WHERE pd.ID_Detalle = dc.ID_Detalle)
				),0) AS Pendientes_Pago
			FROM Comandas c
			WHERE c.Canal = ?2
				AND (${whereClause})
			ORDER BY datetime(c.Fecha_Hora_Apertura) DESC, c.ID_Comanda DESC
			LIMIT ?1;
		`,
		args: [limit, CANAL_BARRA],
	});
	return rows(rs) as ComandaBarraRow[];
}

export async function lineas(
	db: Client,
	idComanda: string,
): Promise<LineaComandaRow[]> {
	const rs = await db.execute({
		sql: `
			SELECT
				dc.ID_Detalle AS ID_Detalle,
				dc.ID_Comanda AS ID_Comanda,
				-- Un producto retirado del catalogo deja esta columna a NULL (ON DELETE SET NULL),
				-- pero en el DTO ID_Producto es un String, no un Option: un null aqui hace que la
				-- Handy no pueda deserializar la respuesta y se quede sin PODER ABRIR la comanda
				-- entera por una sola linea huerfana. La Main ya devuelve "" en ese caso.
				COALESCE(dc.ID_Producto, '') AS ID_Producto,
				COALESCE(dc.Cantidad,1) AS Cantidad,
				COALESCE(dc.Precio_Unitario,0) AS Precio_Unitario,
				dc.Notas AS Notas,
				dc.Estado_Cocina AS Estado_Cocina,
				CASE WHEN EXISTS (
					SELECT 1 FROM v_lineas_cobradas pd WHERE pd.ID_Detalle = dc.ID_Detalle
				) THEN 1 ELSE 0 END AS Pagado,
				COALESCE(dc.Nombre_Producto, p.Nombre, 'Producto') AS Nombre,
				dc.IVA_Percent AS IVA_Percent
			FROM Detalle_Comanda dc
			LEFT JOIN Productos p ON p.ID_Producto = dc.ID_Producto
			WHERE dc.ID_Comanda = ?1
			ORDER BY dc.ID_Detalle ASC;
		`,
		args: [idComanda],
	});
	return rows(rs) as LineaComandaRow[];
}

export async function indexRows(db: Client, ids: string[]): Promise<IndexRow[]> {
	if (!ids.length) return [];
	const placeholders = ids.map((_, i) => `?${i + 1}`).join(",");
	const rs = await db.execute({
		sql: `
			SELECT
				x.ID_Comanda AS ID_Comanda,
				(
					SELECT GROUP_CONCAT(nn.Nombre, ' - ')
					FROM (
						SELECT DISTINCT COALESCE(dc2.Nombre_Producto, p2.Nombre, '') AS Nombre
						FROM Detalle_Comanda dc2
						LEFT JOIN Productos p2 ON p2.ID_Producto = dc2.ID_Producto
						WHERE dc2.ID_Comanda = x.ID_Comanda
						ORDER BY COALESCE(dc2.Nombre_Producto, p2.Nombre, '')
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
	idComanda: string,
): Promise<VerTicketsDetalleRow[]> {
	const rs = await db.execute({
		sql: `
			SELECT
				dc.ID_Detalle AS ID_Detalle,
				-- Mismo motivo que en lineas(): en el DTO ID_Producto es String, no Option, y un
				-- producto retirado del catalogo deja la columna a NULL.
				COALESCE(dc.ID_Producto, '') AS ID_Producto,
				COALESCE(dc.Nombre_Producto, p.Nombre, 'Producto') AS Nombre,
				COALESCE(dc.Cantidad,1) AS Cantidad,
				COALESCE(dc.Precio_Unitario,0) AS Precio_Unitario,
				COALESCE(dc.Estado_Cocina,'PENDIENTE') AS Estado_Cocina,
				CASE WHEN EXISTS (
					SELECT 1 FROM v_lineas_cobradas pd WHERE pd.ID_Detalle = dc.ID_Detalle
				) THEN 1 ELSE 0 END AS Pagado,
				dc.Notas AS Notas,
				dc.IVA_Percent AS IVA_Percent
			FROM Detalle_Comanda dc
			LEFT JOIN Productos p ON p.ID_Producto = dc.ID_Producto
			WHERE dc.ID_Comanda = ?1
			ORDER BY dc.ID_Detalle ASC;
		`,
		args: [idComanda],
	});
	return rows(rs) as VerTicketsDetalleRow[];
}

export type CobroPlan =
	| {
			ok: true;
			id_pago: string;
			importe_total: number;
			id_usuario_cobrador: string | null;
			id_trabajador_cobrador: string | null;
			consumo: PlanConsumo;
		}
	| {
			ok: false;
			error: string;
			productoId?: string;
			requested?: number;
			available?: number;
		};

export async function cobrarPlan(
	db: Client,
	input: CobrarFraccionadoInput,
): Promise<CobroPlan> {
	const placeholders = input.detalles.map((_, i) => `?${i + 2}`).join(",");
	const detalleArgs = [input.id_comanda, ...input.detalles];

	const resumenRs = await db.execute({
		sql: `
			SELECT
				IFNULL(SUM(CAST(ROUND(COALESCE(dc.Cantidad,1) * COALESCE(dc.Precio_Unitario,0)) AS INTEGER)), 0) AS importe,
				COUNT(*) AS num_valid
			FROM Detalle_Comanda dc
			WHERE dc.ID_Comanda = ?1
				AND dc.ID_Detalle IN (${placeholders})
				AND NOT EXISTS (
					SELECT 1 FROM v_lineas_cobradas pd WHERE pd.ID_Detalle = dc.ID_Detalle
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
					SELECT 1 FROM v_lineas_cobradas pd WHERE pd.ID_Detalle = dc.ID_Detalle
				)
			ORDER BY dc.ID_Detalle;
		`,
		args: detalleArgs,
	});
	const charged = rows(chargedRs)
		.map((r) => ({
			id_detalle: String(r.id_detalle ?? ""),
			id_producto: String(r.id_producto ?? ""),
			cantidad: Number(r.cantidad ?? 0),
		}))
		.filter((r) => r.id_detalle.length > 0 && r.id_producto.length > 0 && r.cantidad > 0);

	// VR-01/02/04: sin bloqueo por falta de stock. Reparto FEFO (lotes nunca negativos) y el
	// sobrante al stock suelto.
	const consumo = await planConsumo(db, charged);

	const idUsuario = input.id_usuario_cobrador;
	const idTrabFromUser = await resolveTrabajadorId(db, idUsuario);
	const comandaRs = await db.execute({
		sql: "SELECT ID_Trabajador AS id FROM Comandas WHERE ID_Comanda = ?1 LIMIT 1;",
		args: [input.id_comanda],
	});
	const idTrabComanda = recortar(String(rows(comandaRs)[0]?.id ?? "")) || null;

	return {
		ok: true,
		id_pago: nuevoId(),
		importe_total: Number(resumen.importe ?? 0),
		id_usuario_cobrador: idUsuario,
		id_trabajador_cobrador:
			input.id_trabajador_cobrador ?? idTrabFromUser ?? idTrabComanda,
		consumo,
	};
}

// Basta con que la comanda tenga UN cobro, activo o anulado (CUENTA-07). Y no es una sutileza:
// `Pagos.ID_Comanda` va con `ON DELETE CASCADE`, asi que borrar la comanda se llevaria por delante
// la fila del cobro anulado -que es justo la prueba que ese cambio existe para conservar. Por eso
// se mira `Pagos`, como `delete_comanda_if_safe` de la Main.
//
// AUD-14: y además las lineas de la comanda que esten en `v_lineas_cobradas`, aunque su cobro sea
// de otra comanda: es la misma condicion que llevan los `DELETE` de `deleteComandaIfSafe`, y la ruta
// tiene que decir lo mismo que ellos (si no borran nada, no se ha borrado). El borrado propio de la
// Main sigue mirando solo `Pagos`.
export async function hasPaidLines(db: Client, idComanda: string): Promise<boolean> {
	const rs = await db.execute({
		sql: `SELECT EXISTS(SELECT 1 FROM Pagos WHERE ID_Comanda = ?1)
			OR EXISTS(
				SELECT 1 FROM v_lineas_cobradas v
				JOIN Detalle_Comanda dc ON dc.ID_Detalle = v.ID_Detalle
				WHERE dc.ID_Comanda = ?1
			) AS has_paid;`,
		args: [idComanda],
	});
	return Number(rows(rs)[0]?.has_paid ?? 0) === 1;
}
