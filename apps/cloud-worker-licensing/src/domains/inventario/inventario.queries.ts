// src/domains/inventario/inventario.queries.ts
//
// LECTURAS de inventario. SQL idéntico al de la app local (crate
// tpv-infra-sqlite/inventario.rs): mismas columnas/alias en PascalCase, de modo que
// las filas ya salen con la forma de los DTOs de @tpv/contracts. Van a la base por `tenantQuery`,
// sin pasar por el motor de escritura: son datos de solo lectura, sin idempotencia que romper.

import type { Client } from "@libsql/client/web";

import type {
	CategoriaInvDto,
	ProveedorMiniDto,
	ProductoListDto,
	AlergenoInvDto,
	LoteDto,
	InventarioResumenResponse,
	ProductDetailResponse,
	ProductoBaseDto,
} from "@tpv/contracts";

// Convierte el ResultSet de libsql en objetos planos {columna: valor}. Las filas de
// libsql son array-like; sin esto se serializarían como arrays.
function rows(rs: any): any[] {
	const cols: string[] = rs?.columns ?? [];
	return (rs?.rows ?? []).map((r: any) => {
		const o: Record<string, any> = {};
		cols.forEach((col, i) => {
			o[col] = r[i];
		});
		return o;
	});
}

// IVA_Percent va en la lista: es una columna del DTO como cualquier otra, y dejarla fuera hacia que
// la Handy viera todos los productos como si heredaran el IVA del negocio.
const PRODUCTO_BASE_COLS =
	"ID_Producto, ID_Categoria, ID_Proveedor, Nombre, Precio_Venta, Stock_Minimo, Unidad_Medida, Nombre_Imagen, Ruta_Imagen, Cantidad_Pedido_Esperada, Stock_Suelto, IVA_Percent";

export async function listCategorias(db: Client): Promise<CategoriaInvDto[]> {
	const rs = await db.execute(
		"SELECT ID_Categoria, Nombre, Nombre_Imagen, Ruta_Imagen, Vendible, Pasa_Cocina FROM Categorias_Producto ORDER BY Nombre ASC;",
	);
	return rows(rs) as CategoriaInvDto[];
}

export async function listProveedoresMini(db: Client): Promise<ProveedorMiniDto[]> {
	const rs = await db.execute(
		"SELECT ID_Proveedor, Nombre_Empresa, Email FROM Proveedores ORDER BY Nombre_Empresa ASC;",
	);
	return rows(rs) as ProveedorMiniDto[];
}

export async function listProductosByCategoria(
	db: Client,
	idCategoria: string,
): Promise<ProductoListDto[]> {
	const rs = await db.execute({
		sql: `
			SELECT
				p.ID_Producto, p.ID_Categoria, p.ID_Proveedor, p.Nombre, p.Precio_Venta,
				((SELECT COALESCE(SUM(l.Stock_Disponible), 0) FROM Lotes_Producto l WHERE l.ID_Producto = p.ID_Producto) + COALESCE(p.Stock_Suelto, 0)) AS Stock_Actual,
				p.Stock_Minimo, p.Unidad_Medida, p.Nombre_Imagen, p.Ruta_Imagen,
				(SELECT l.Caducidad FROM Lotes_Producto l WHERE l.ID_Producto = p.ID_Producto AND l.Stock_Disponible > 0 AND l.Caducidad IS NOT NULL ORDER BY date(l.Caducidad) ASC, datetime(l.Fecha_Entrada) ASC, l.ID_Lote ASC LIMIT 1) AS Caducidad_Proxima,
				(SELECT l.Codigo_Lote FROM Lotes_Producto l WHERE l.ID_Producto = p.ID_Producto AND l.Stock_Disponible > 0 AND l.Caducidad IS NOT NULL ORDER BY date(l.Caducidad) ASC, datetime(l.Fecha_Entrada) ASC, l.ID_Lote ASC LIMIT 1) AS Lote_Proximo,
				p.Cantidad_Pedido_Esperada,
				p.Stock_Suelto,
				-- El IVA propio del producto. Faltaba aqui, asi que la Handy veia
				-- todos los productos como si heredaran el IVA del negocio: editar uno desde la
				-- Handy podia devolverle el tipo general sin que nadie lo pidiera.
				p.IVA_Percent
			FROM Productos p
			WHERE p.ID_Categoria = ?1
				AND p.Archivado_En IS NULL -- RI-54: un archivado ya no es del inventario
			ORDER BY p.Nombre ASC;
		`,
		args: [idCategoria],
	});
	return rows(rs) as ProductoListDto[];
}

export async function resumen(
	db: Client,
	limit: number,
): Promise<InventarioResumenResponse> {
	const cad = await db.execute({
		sql: `
			SELECT p.Nombre, l.Stock_Disponible AS Stock_Actual, p.Unidad_Medida, l.Caducidad AS Caducidad_Proxima, l.Codigo_Lote AS Lote, p.Precio_Venta
			FROM Lotes_Producto l
			JOIN Productos p ON p.ID_Producto = l.ID_Producto
			WHERE l.Stock_Disponible > 0 AND l.Caducidad IS NOT NULL
				AND p.Archivado_En IS NULL
			ORDER BY date(l.Caducidad) ASC, datetime(l.Fecha_Entrada) ASC, l.ID_Lote ASC
			LIMIT ?1;
		`,
		args: [limit],
	});

	const low = await db.execute({
		sql: `
			-- INV-04: sin subconsultas correlacionadas por fila. Stock por producto con un
			-- GROUP BY, y el lote FEFO (próximo a caducar) con una ventana ROW_NUMBER.
			WITH stock_por_prod AS (
				SELECT ID_Producto, COALESCE(SUM(Stock_Disponible), 0) AS Stock_Actual
				FROM Lotes_Producto
				GROUP BY ID_Producto
			),
			fefo AS (
				SELECT ID_Producto, Caducidad, Codigo_Lote
				FROM (
					SELECT ID_Producto, Caducidad, Codigo_Lote,
						ROW_NUMBER() OVER (
							PARTITION BY ID_Producto
							ORDER BY date(Caducidad) ASC, datetime(Fecha_Entrada) ASC, ID_Lote ASC
						) AS rn
					FROM Lotes_Producto
					WHERE Stock_Disponible > 0 AND Caducidad IS NOT NULL
				)
				WHERE rn = 1
			)
			SELECT
				p.Nombre,
				COALESCE(sp.Stock_Actual, 0) + COALESCE(p.Stock_Suelto, 0) AS Stock_Actual,
				p.Unidad_Medida,
				f.Caducidad AS Caducidad_Proxima,
				f.Codigo_Lote AS Lote,
				p.Precio_Venta
			FROM Productos p
			LEFT JOIN stock_por_prod sp ON sp.ID_Producto = p.ID_Producto
			LEFT JOIN fefo f ON f.ID_Producto = p.ID_Producto
			WHERE p.Archivado_En IS NULL
			ORDER BY Stock_Actual ASC, p.Nombre ASC
			LIMIT ?1;
		`,
		args: [limit],
	});

	return {
		proximosCaducar: rows(cad),
		menosCantidad: rows(low),
	} as unknown as InventarioResumenResponse;
}

export async function listAlergenos(db: Client): Promise<AlergenoInvDto[]> {
	const rs = await db.execute(
		"SELECT ID_Alergeno, Nombre, Nombre_Imagen, Ruta_Imagen FROM Alergenos ORDER BY Nombre ASC;",
	);
	return rows(rs) as AlergenoInvDto[];
}

export async function productDetail(
	db: Client,
	idProducto: string,
): Promise<ProductDetailResponse> {
	const prodRs = await db.execute({
		sql: `SELECT ${PRODUCTO_BASE_COLS} FROM Productos WHERE ID_Producto=?1 LIMIT 1;`,
		args: [idProducto],
	});
	const producto = (rows(prodRs)[0] ?? null) as ProductoBaseDto | null;

	const alergRs = await db.execute({
		sql: `
			SELECT a.ID_Alergeno, a.Nombre, a.Nombre_Imagen, a.Ruta_Imagen
			FROM Producto_Alergenos pa
			JOIN Alergenos a ON a.ID_Alergeno = pa.ID_Alergeno
			WHERE pa.ID_Producto = ?1
			ORDER BY a.Nombre ASC;
		`,
		args: [idProducto],
	});

	return {
		producto,
		alergenos: rows(alergRs),
	} as unknown as ProductDetailResponse;
}

// El `Stock_Disponible` del lote si existe. Es el disponible PREVIO, que da el delta del
// movimiento de auditoría (INV-01b) al editar o ajustar.
export async function getLoteStock(
	db: Client,
	idLote: string,
): Promise<{ stock_disponible: number } | null> {
	const rs = await db.execute({
		sql: "SELECT Stock_Disponible FROM Lotes_Producto WHERE ID_Lote=?1 LIMIT 1;",
		args: [idLote],
	});
	const r = rows(rs)[0];
	if (!r) return null;
	return { stock_disponible: Number(r.Stock_Disponible ?? 0) };
}

// RI-55: el stock suelto de un producto, o `undefined` si el producto no existe (`null` es que
// no lleva stock suelto).
export async function getProductoStockSuelto(
	db: Client,
	idProducto: string,
): Promise<number | null | undefined> {
	const rs = await db.execute({
		sql: "SELECT Stock_Suelto FROM Productos WHERE ID_Producto=?1 LIMIT 1;",
		args: [idProducto],
	});
	const r = rows(rs)[0];
	if (!r) return undefined;
	return r.Stock_Suelto == null ? null : Number(r.Stock_Suelto);
}

export async function listLotesByProducto(
	db: Client,
	idProducto: string,
): Promise<LoteDto[]> {
	const rs = await db.execute({
		sql: `
			SELECT ID_Lote, ID_Producto, Codigo_Lote, Fecha_Entrada, Caducidad, Stock_Disponible, Coste_Unitario, ID_Proveedor, Notas
			FROM Lotes_Producto
			WHERE ID_Producto=?1
			ORDER BY (Caducidad IS NULL) ASC, date(Caducidad) ASC, datetime(Fecha_Entrada) DESC, ID_Lote DESC;
		`,
		args: [idProducto],
	});
	return rows(rs) as LoteDto[];
}
