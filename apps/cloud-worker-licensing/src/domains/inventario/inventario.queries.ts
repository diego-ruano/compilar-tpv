// src/domains/inventario/inventario.queries.ts
//
// LECTURAS de inventario. SQL idéntico al de la app local (crate
// tpv-infra-sqlite/inventario.rs): mismas columnas/alias en PascalCase, de modo que
// las filas ya salen con la forma de los DTOs de @tpv/contracts. Van directas a
// Turso (sin DO): son datos de solo lectura, sin idempotencia que romper.

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

const PRODUCTO_BASE_COLS =
	"ID_Producto, ID_Categoria, ID_Proveedor, Nombre, Precio_Venta, Stock_Minimo, Unidad_Medida, Nombre_Imagen, Ruta_Imagen, Cantidad_Pedido_Esperada";

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
	idCategoria: number,
): Promise<ProductoListDto[]> {
	const rs = await db.execute({
		sql: `
			SELECT
				p.ID_Producto, p.ID_Categoria, p.ID_Proveedor, p.Nombre, p.Precio_Venta,
				(SELECT COALESCE(SUM(l.Stock_Disponible), 0) FROM Lotes_Producto l WHERE l.ID_Producto = p.ID_Producto) AS Stock_Actual,
				p.Stock_Minimo, p.Unidad_Medida, p.Nombre_Imagen, p.Ruta_Imagen,
				(SELECT l.Caducidad FROM Lotes_Producto l WHERE l.ID_Producto = p.ID_Producto AND l.Stock_Disponible > 0 AND l.Caducidad IS NOT NULL ORDER BY date(l.Caducidad) ASC, datetime(l.Fecha_Entrada) ASC, l.ID_Lote ASC LIMIT 1) AS Caducidad_Proxima,
				(SELECT l.Codigo_Lote FROM Lotes_Producto l WHERE l.ID_Producto = p.ID_Producto AND l.Stock_Disponible > 0 AND l.Caducidad IS NOT NULL ORDER BY date(l.Caducidad) ASC, datetime(l.Fecha_Entrada) ASC, l.ID_Lote ASC LIMIT 1) AS Lote_Proximo,
				p.Cantidad_Pedido_Esperada
			FROM Productos p
			WHERE p.ID_Categoria = ?1
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
			ORDER BY date(l.Caducidad) ASC, datetime(l.Fecha_Entrada) ASC, l.ID_Lote ASC
			LIMIT ?1;
		`,
		args: [limit],
	});

	const low = await db.execute({
		sql: `
			WITH base AS (
				SELECT p.ID_Producto, p.Nombre, p.Unidad_Medida, p.Precio_Venta,
					(SELECT COALESCE(SUM(l.Stock_Disponible), 0) FROM Lotes_Producto l WHERE l.ID_Producto = p.ID_Producto) AS Stock_Actual,
					(SELECT l.Caducidad FROM Lotes_Producto l WHERE l.ID_Producto = p.ID_Producto AND l.Stock_Disponible > 0 AND l.Caducidad IS NOT NULL ORDER BY date(l.Caducidad) ASC, datetime(l.Fecha_Entrada) ASC, l.ID_Lote ASC LIMIT 1) AS Caducidad_Proxima,
					(SELECT l.Codigo_Lote FROM Lotes_Producto l WHERE l.ID_Producto = p.ID_Producto AND l.Stock_Disponible > 0 AND l.Caducidad IS NOT NULL ORDER BY date(l.Caducidad) ASC, datetime(l.Fecha_Entrada) ASC, l.ID_Lote ASC LIMIT 1) AS Lote
				FROM Productos p
			)
			SELECT Nombre, Stock_Actual, Unidad_Medida, Caducidad_Proxima, Lote, Precio_Venta
			FROM base
			ORDER BY Stock_Actual ASC, Nombre ASC
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

export async function alergenosProducto(
	db: Client,
	idProducto: number,
): Promise<number[]> {
	const rs = await db.execute({
		sql: "SELECT ID_Alergeno FROM Producto_Alergenos WHERE ID_Producto=?1 ORDER BY ID_Alergeno ASC;",
		args: [idProducto],
	});
	return (rs.rows ?? [])
		.map((r: any) => Number(r[0]))
		.filter((n: number) => Number.isFinite(n) && n > 0);
}

export async function productDetail(
	db: Client,
	idProducto: number,
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

export async function listLotesByProducto(
	db: Client,
	idProducto: number,
): Promise<LoteDto[]> {
	const rs = await db.execute({
		sql: `
			SELECT ID_Lote, ID_Producto, Codigo_Lote, Fecha_Entrada, Caducidad, Cantidad_Inicial, Stock_Disponible, Coste_Unitario, ID_Proveedor, Notas
			FROM Lotes_Producto
			WHERE ID_Producto=?1
			ORDER BY (Caducidad IS NULL) ASC, date(Caducidad) ASC, datetime(Fecha_Entrada) DESC, ID_Lote DESC;
		`,
		args: [idProducto],
	});
	return rows(rs) as LoteDto[];
}
